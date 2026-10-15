"""Ariadne 桌面版启动器（pywebview + 内置 FastAPI 后端）。

开发时直接运行：  npm run desktop -- --dev        （等价于在 backend 目录 uv run --with pywebview python ../desktop/launcher.py）
打包：            npm run desktop                  （PyInstaller → desktop/dist/Ariadne/）

做的事情：
1. 数据放在用户目录（Windows: %APPDATA%\\Ariadne，macOS: ~/Library/Application Support/Ariadne），
   安装目录只读也没关系；可用环境变量 ARIA_DATA_DIR 覆盖。
2. 后端只监听 127.0.0.1 的随机空闲端口，不和别的程序抢 8000。
3. 只允许一个实例：再次双击时唤起已打开的窗口。
4. 窗口先显示「正在启动」，后端就绪后再加载页面；启动失败显示日志位置。
5. 关闭窗口即退出，后端随之停止，不留后台进程。

参数：
  --headless   不开窗口，只启动后端并打印地址（用于自动化测试 / CI 冒烟）
  --port N     指定端口（默认随机）
"""
from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP_NAME = "Ariadne"
TITLE = "Ariadne · 研究报告助手"
FROZEN = getattr(sys, "frozen", False)
# 打包后资源在 PyInstaller 的解压目录；开发时是仓库根目录
ROOT = Path(getattr(sys, "_MEIPASS", "")) if FROZEN else Path(__file__).resolve().parent.parent

log = logging.getLogger("ariadne.desktop")


def user_data_dir() -> Path:
    if os.getenv("ARIA_DATA_DIR"):
        return Path(os.environ["ARIA_DATA_DIR"])
    if sys.platform == "win32":
        base = Path(os.getenv("APPDATA") or Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_NAME


def setup_logging(data: Path) -> Path:
    logs = data / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    path = logs / "desktop.log"
    handler = logging.handlers.RotatingFileHandler(path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    if not FROZEN or sys.stderr:
        root.addHandler(logging.StreamHandler())
    return path


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _post(url: str, timeout: float = 1.5) -> bool:
    try:
        req = urllib.request.Request(url, data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 只访问本机
            return r.status == 200
    except OSError:
        return False


def _healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:  # noqa: S310
            return r.status == 200
    except OSError:
        return False


def activate_existing(lock: Path) -> bool:
    """已有实例在运行就让它把窗口调到前台，返回 True"""
    try:
        info = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return _post(f"http://127.0.0.1:{info['port']}/api/desktop/activate")


LOADING_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;
font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#616161;background:#fff}
.dot{width:10px;height:10px;border-radius:50%;background:#0078d4;display:inline-block;margin:0 4px;animation:b 1s infinite}
.dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
@keyframes b{0%,80%,100%{opacity:.25}40%{opacity:1}}h1{font-size:22px;color:#242424;font-weight:600;margin:0 0 6px}
</style></head><body><h1>Ariadne</h1><div style="margin-bottom:18px">研究报告助手正在启动…</div>
<div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></body></html>"""


def error_html(msg: str, log_path: Path) -> str:
    from html import escape

    return (
        "<!doctype html><html><head><meta charset='utf-8'></head><body style=\"font-family:'Segoe UI','Microsoft YaHei',sans-serif;"
        "padding:40px;color:#242424\"><h2 style='color:#a4262c'>启动失败</h2>"
        f"<p>{escape(msg)}</p><p style='color:#616161'>详细日志：<code>{escape(str(log_path))}</code></p></body></html>"
    )


class Backend:
    """在后台线程里运行 uvicorn，便于随窗口一起停止"""

    def __init__(self, port: int):
        import uvicorn

        from app.main import app  # 延迟导入：环境变量要先设置好

        self.window = None

        @app.post("/api/desktop/activate", include_in_schema=False)
        def activate():
            w = self.window
            if w is not None:
                try:
                    w.restore()
                    w.show()
                except Exception:  # noqa: BLE001
                    log.exception("唤起窗口失败")
            return {"ok": True}

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, log_level="warning", access_log=False)
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="uvicorn", daemon=True)
        self.port = port

    def start(self, timeout: float = 60) -> None:
        self.thread.start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.thread.is_alive():
                raise RuntimeError("后端进程意外退出，可能是端口被占用")
            if _healthy(self.port):
                return
            time.sleep(0.15)
        raise TimeoutError(f"后端 {timeout:.0f} 秒内没有就绪")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog=APP_NAME)
    ap.add_argument("--headless", action="store_true", help="不开窗口，只启动后端")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args(argv)

    data = user_data_dir()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["ARIA_DATA_DIR"] = str(data)
    os.environ.setdefault("ARIA_FRONTEND_DIST", str(ROOT / "frontend" / "dist"))
    log_path = setup_logging(data)
    log.info("启动 %s（%s），数据目录 %s", APP_NAME, "打包版" if FROZEN else "开发模式", data)

    lock = data / "desktop.json"
    if not args.headless and activate_existing(lock):
        log.info("已有实例在运行，已唤起其窗口")
        return 0

    if not FROZEN:
        sys.path.insert(0, str(ROOT / "backend"))
    port = args.port or free_port()

    if args.headless:
        backend = Backend(port)
        backend.start()
        print(f"Ariadne 已就绪：http://127.0.0.1:{port}", flush=True)
        try:
            while backend.thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            backend.stop()
        return 0

    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True  # 导出 LaTeX / Markdown / BibTeX
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True  # 论文链接、官网价格页用系统浏览器打开
    window = webview.create_window(TITLE, html=LOADING_HTML, width=1440, height=900, min_size=(1000, 640))
    state: dict = {}

    def boot() -> None:
        try:
            backend = Backend(port)
            backend.window = window
            state["backend"] = backend
            backend.start()
            lock.write_text(json.dumps({"pid": os.getpid(), "port": port}), encoding="utf-8")
            window.load_url(f"http://127.0.0.1:{port}/")
            log.info("已就绪：http://127.0.0.1:%s", port)
        except Exception as e:  # noqa: BLE001
            log.exception("启动失败")
            window.load_html(error_html(str(e), log_path))

    icon = ROOT / "frontend" / "dist" / "ariadne-512.png"
    webview.start(
        boot,
        private_mode=False,  # 保留 localStorage：设置窗口大小、批注缓存等
        storage_path=str(data / "webview"),
        icon=str(icon) if icon.exists() else None,
    )

    # 窗口关闭后
    if "backend" in state:
        state["backend"].stop()
    try:
        info = json.loads(lock.read_text(encoding="utf-8"))
        if info.get("pid") == os.getpid():
            lock.unlink()
    except (OSError, json.JSONDecodeError):
        pass
    log.info("已退出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
