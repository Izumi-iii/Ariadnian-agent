"""Ariadne 桌面版的后端进程：由 Electron 启动，打包成 ariadne-server(.exe)。

  ariadne-server --port 51234

- 只监听 127.0.0.1；端口由 Electron 分配后传进来。
- 数据目录由 Electron 通过环境变量 ARIA_DATA_DIR 指定（默认同下面 user_data_dir 的规则），
  也可以单独运行它做调试：python desktop/server.py --port 8765
- 日志同时写到 <数据目录>/logs/server.log 和标准输出（Electron 会把标准输出记进 electron.log）。
- 父进程（Electron）退出后自动退出，防止留下孤儿进程。
"""
from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import sys
import threading
import time
from pathlib import Path

APP_NAME = "Ariadne"
FROZEN = getattr(sys, "frozen", False)
# 打包后资源在 PyInstaller 的解压目录；开发时是仓库根目录
ROOT = Path(getattr(sys, "_MEIPASS", "")) if FROZEN else Path(__file__).resolve().parent.parent

log = logging.getLogger("ariadne.server")


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


def setup_logging(data: Path) -> None:
    logs = data / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file = logging.handlers.RotatingFileHandler(logs / "server.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file)
    if sys.stdout:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(fmt)
        root.addHandler(console)


def watch_parent() -> None:
    """Electron 被强制结束时不会通知子进程；父进程消失就自行退出"""
    ppid = os.getppid()

    def loop() -> None:
        while True:
            time.sleep(2)
            gone = os.getppid() != ppid if sys.platform != "win32" else not _pid_alive(ppid)
            if gone:
                log.info("父进程已退出，后端随之退出")
                os._exit(0)

    threading.Thread(target=loop, name="watch-parent", daemon=True).start()


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ariadne-server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-watch-parent", action="store_true", help="单独调试时使用：不随父进程退出")
    args = ap.parse_args(argv)

    data = user_data_dir()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["ARIA_DATA_DIR"] = str(data)
    os.environ.setdefault("ARIA_FRONTEND_DIST", str(ROOT / "frontend" / "dist"))
    setup_logging(data)
    log.info("启动后端（%s），数据目录 %s，端口 %s", "打包版" if FROZEN else "开发模式", data, args.port)

    if not FROZEN:
        sys.path.insert(0, str(ROOT / "backend"))
    if not args.no_watch_parent:
        watch_parent()

    import uvicorn

    from app.main import app  # 环境变量设置好之后再导入

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_config=None, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
