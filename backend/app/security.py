"""部署给别人用时的安全设置（本地 / 桌面版默认全部关闭，行为不变）。

    ARIA_PASSWORD          访问密码。设置后所有页面和接口都要求 HTTP Basic 认证（用户名随意或用 ARIA_USERNAME）
    ARIA_USERNAME          （可选）指定用户名，默认任意用户名都可以
    ARIA_LOCK_SETTINGS=1   锁定「设置」：网页上只能查看，不能修改模型 / 密钥，也不能测试任意地址
    ARIA_MAX_UPLOAD_MB     上传文件大小上限，默认 50
    ARIA_ALLOW_PRIVATE_URLS=1  允许下载内网 / 本机地址的 PDF（默认禁止，防止被用来探测服务器内网）
    ARIA_REQUIRE_PASSWORD=1    没设置 ARIA_PASSWORD 就拒绝启动（Docker 镜像默认开启，避免忘设密码直接暴露在公网）

公网部署务必放在 HTTPS 后面（见 deploy/Caddyfile），否则 Basic 认证的密码是明文传输的。
"""
from __future__ import annotations

import base64
import hmac
import ipaddress
import os
import socket
from urllib.parse import urlsplit

# 不需要密码的路径：容器健康检查
PUBLIC_PATHS = {"/api/health"}


def _truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in {"1", "true", "yes", "on"}


def check_startup() -> None:
    if _truthy(os.getenv("ARIA_REQUIRE_PASSWORD")) and not os.getenv("ARIA_PASSWORD"):
        raise SystemExit(
            "未设置访问密码：请设置环境变量 ARIA_PASSWORD（docker compose 在 deploy/ariadne.env 里填写）。\n"
            "只在本机自己用、确定不需要密码时，可以设置 ARIA_REQUIRE_PASSWORD=0。"
        )


def settings_locked() -> bool:
    return _truthy(os.getenv("ARIA_LOCK_SETTINGS"))


def max_upload_bytes() -> int:
    try:
        mb = float(os.getenv("ARIA_MAX_UPLOAD_MB") or 50)
    except ValueError:
        mb = 50
    return int(mb * 1024 * 1024)


# ---------------------------------------------------------------------------
# 访问密码：纯 ASGI 中间件（不包装响应体，SSE 流式输出不受影响）
# ---------------------------------------------------------------------------
class PasswordMiddleware:
    def __init__(self, app, password: str | None = None, username: str | None = None):
        self.app = app
        self.password = password if password is not None else os.getenv("ARIA_PASSWORD") or ""
        self.username = username if username is not None else os.getenv("ARIA_USERNAME") or ""

    def _ok(self, header: bytes | None) -> bool:
        if not header or not header.lower().startswith(b"basic "):
            return False
        try:
            user, _, pw = base64.b64decode(header[6:].strip()).decode("utf-8").partition(":")
        except (ValueError, UnicodeDecodeError):
            return False
        pw_ok = hmac.compare_digest(pw.encode(), self.password.encode())
        user_ok = not self.username or hmac.compare_digest(user.encode(), self.username.encode())
        return pw_ok and user_ok

    async def __call__(self, scope, receive, send):
        if not self.password or scope["type"] not in ("http", "websocket") or scope.get("path") in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "http" and scope.get("method") == "OPTIONS":  # CORS 预检不带凭据
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        if self._ok(headers.get(b"authorization")):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        body = "需要访问密码".encode()
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"www-authenticate", b'Basic realm="Ariadne", charset="UTF-8"'),
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})


# ---------------------------------------------------------------------------
# 外部地址检查：下载 PDF 等由用户可控的地址，禁止指向本机 / 内网
# ---------------------------------------------------------------------------
class UnsafeURL(ValueError):
    pass


def _ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global or ip.is_multicast


def check_public_url(url: str) -> None:
    """只允许 http(s)，且主机解析出的所有地址都必须是公网地址。不通过时抛出 UnsafeURL。"""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURL(f"只支持 http / https 链接：{url}")
    host = parts.hostname
    if not host:
        raise UnsafeURL(f"链接缺少主机名：{url}")
    if _truthy(os.getenv("ARIA_ALLOW_PRIVATE_URLS")):
        return
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise UnsafeURL(f"无法解析主机 {host}：{e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if _ip_blocked(ip):
            raise UnsafeURL(f"不允许访问内网或本机地址：{host}（{ip}）")
