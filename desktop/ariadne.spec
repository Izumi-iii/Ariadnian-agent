# -*- mode: python ; coding: utf-8 -*-
# 桌面版后端的 PyInstaller 打包配置（由 npm run desktop 调用，也可以在 backend 目录执行
#   uv run --with pyinstaller pyinstaller ../desktop/ariadne.spec）
# 产物：desktop/dist/ariadne-server/（单目录，启动快），再由 Electron 作为附带程序打进安装包
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
DIST = ROOT / "frontend" / "dist"
if not (DIST / "index.html").exists():
    raise SystemExit("找不到 frontend/dist，请先构建前端（npm run desktop 会自动构建）")

datas = [(str(DIST), "frontend/dist")]
binaries = []
hiddenimports = collect_submodules("app") + collect_submodules("uvicorn") + collect_submodules("langgraph")
hiddenimports += ["tiktoken_ext.openai_public", "tiktoken_ext"]

# litellm 运行时会读取自带的模型价格表、tokenizer 等数据文件；jieba 需要词典
for pkg in ("litellm", "tiktoken"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h
datas += collect_data_files("jieba")

a = Analysis(
    [str(ROOT / "desktop" / "server.py")],
    pathex=[str(ROOT / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # boto3 / botocore 只在 AWS Bedrock 时用到（27 MB），不打包
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "notebook", "PyQt5", "PyQt6", "PySide2", "PySide6", "boto3", "botocore"],
    noarchive=False,
)
# 去掉用不到的大文件：litellm 代理服务器的网页界面和接口文档、jieba 的 paddle 模型
_SKIP = ("litellm/proxy/_experimental", "litellm/proxy/swagger", "litellm/proxy/_lazy_openapi_snapshot.json", "jieba/lac_small")
a.datas = [x for x in a.datas if not any(x[0].replace(os.sep, "/").startswith(s) for s in _SKIP)]
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ariadne-server",
    console=True,  # 由 Electron 以隐藏窗口方式启动；保留控制台输出便于记录日志
    icon=str(ROOT / "desktop" / "ariadne.ico") if os.name == "nt" else None,  # 只有 Windows 的 exe 需要图标
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="ariadne-server", upx=False)
