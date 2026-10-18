"""部署相关的安全设置：访问密码、设置锁定、上传上限、PDF 下载地址检查。全部离线。"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
from pathlib import Path

import httpx
import pytest

os.environ.setdefault("LLM_FAKE", "1")
os.environ.setdefault("ARIA_DATA_DIR", tempfile.mkdtemp(prefix="aria-sec-"))
os.environ.setdefault("EMBEDDING_PROVIDER", "none")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import scholar, security  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def _basic(user: str, pw: str) -> dict:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


def _protected_app(password: str, username: str = "") -> TestClient:
    inner = FastAPI()

    @inner.get("/api/health")
    def health():
        return {"ok": True}

    @inner.get("/api/stream")
    def stream():
        return StreamingResponse((f"data: {i}\n\n" for i in range(3)), media_type="text/event-stream")

    @inner.get("/")
    def index():
        return {"page": True}

    return TestClient(security.PasswordMiddleware(inner, password=password, username=username))


def test_password_required_except_health():
    c = _protected_app("s3cret")
    assert c.get("/api/health").status_code == 200  # 健康检查不需要密码
    r = c.get("/")
    assert r.status_code == 401 and "Basic" in r.headers["www-authenticate"]
    assert c.get("/", headers=_basic("anyone", "wrong")).status_code == 401
    assert c.get("/", headers=_basic("anyone", "s3cret")).json() == {"page": True}
    # 流式接口（SSE）在认证后正常输出
    r = c.get("/api/stream", headers=_basic("x", "s3cret"))
    assert r.status_code == 200 and r.text.count("data:") == 3


def test_password_with_username_and_garbage_header():
    c = _protected_app("pw", username="alice")
    assert c.get("/", headers=_basic("bob", "pw")).status_code == 401
    assert c.get("/", headers=_basic("alice", "pw")).status_code == 200
    assert c.get("/", headers={"Authorization": "Basic !!!not-base64"}).status_code == 401


def test_no_password_means_open():
    assert _protected_app("").get("/").status_code == 200


def test_settings_lock(monkeypatch):
    monkeypatch.setenv("ARIA_LOCK_SETTINGS", "1")
    assert client.get("/api/settings").json()["locked"] is True
    r = client.put("/api/settings", json={"values": {"MODEL_ID": "deepseek/deepseek-chat"}})
    assert r.status_code == 403
    # 锁定时不能把服务器上的密钥拿去测试任意地址
    r = client.post("/api/settings/test-llm", json={"api_base": "https://evil.example/v1"})
    assert r.status_code == 403
    assert client.post("/api/settings/test-llm", json={"tier": "write"}).status_code == 200
    monkeypatch.delenv("ARIA_LOCK_SETTINGS")
    assert client.get("/api/settings").json()["locked"] is False


def test_upload_size_limit(monkeypatch):
    monkeypatch.setenv("ARIA_MAX_UPLOAD_MB", "0.001")  # 约 1 KB
    r = client.post("/api/papers/upload", files={"file": ("big.txt", b"x" * 5000, "text/plain")})
    assert r.status_code == 413
    r = client.post("/api/papers/upload", files={"file": ("small.txt", b"hello world " * 20, "text/plain")})
    assert r.status_code == 200


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/x.pdf",
    "http://localhost/x.pdf",
    "http://10.0.0.5/x.pdf",
    "http://192.168.1.1/x.pdf",
    "http://169.254.169.254/latest/meta-data",  # 云服务器元数据地址
    "http://[::1]/x.pdf",
    "file:///etc/passwd",
    "ftp://example.com/x.pdf",
])
def test_private_urls_blocked(url):
    with pytest.raises(security.UnsafeURL):
        security.check_public_url(url)


def test_public_url_allowed_and_override(monkeypatch):
    monkeypatch.setattr(security.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    security.check_public_url("https://example.org/paper.pdf")
    monkeypatch.setenv("ARIA_ALLOW_PRIVATE_URLS", "1")
    security.check_public_url("http://127.0.0.1/x.pdf")


def test_download_pdf_blocks_redirect_to_private(monkeypatch, tmp_path):
    def resolve(host, *a, **k):
        ip = "127.0.0.1" if host == "localhost" else "93.184.216.34"
        return [(2, 1, 6, "", (ip, 80))]

    monkeypatch.setattr(security.socket, "getaddrinfo", resolve)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "papers.example":
            return httpx.Response(302, headers={"location": "http://localhost/secret.pdf"})
        return httpx.Response(200, content=b"%PDF-1.4 secret")

    monkeypatch.setattr(scholar, "_TRANSPORT", httpx.MockTransport(handler))
    with pytest.raises(security.UnsafeURL):
        scholar.download_pdf("https://papers.example/a.pdf", tmp_path / "a.pdf")
    assert not (tmp_path / "a.pdf").exists()


def test_download_pdf_ok_and_size_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(security.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])
    monkeypatch.setattr(scholar, "_TRANSPORT", httpx.MockTransport(lambda req: httpx.Response(200, content=b"%PDF-1.4" + b"0" * 4000)))
    path = scholar.download_pdf("https://papers.example/a.pdf", tmp_path / "a.pdf")
    assert path.read_bytes().startswith(b"%PDF-")
    with pytest.raises(ValueError, match="上限"):
        scholar.download_pdf("https://papers.example/b.pdf", tmp_path / "b.pdf", max_bytes=1000)
    assert not (tmp_path / "b.pdf").exists() and not (tmp_path / "b.part").exists()


def test_require_password_at_startup(monkeypatch):
    monkeypatch.setenv("ARIA_REQUIRE_PASSWORD", "1")
    monkeypatch.delenv("ARIA_PASSWORD", raising=False)
    with pytest.raises(SystemExit, match="ARIA_PASSWORD"):
        security.check_startup()
    monkeypatch.setenv("ARIA_PASSWORD", "pw")
    security.check_startup()
    monkeypatch.setenv("ARIA_REQUIRE_PASSWORD", "0")
    monkeypatch.delenv("ARIA_PASSWORD")
    security.check_startup()
