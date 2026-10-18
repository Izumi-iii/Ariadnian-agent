# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# Ariadne 网页版镜像：前端构建产物由 FastAPI 一起托管，一个容器、一个端口（8000）。
#
#   docker build -t ariadne .
#   docker run -d -p 8000:8000 -v ariadne-data:/data -e ARIA_PASSWORD=换成你的密码 -e LLM_API_KEY=sk-... ariadne
#
# 镜像默认要求设置访问密码（ARIA_PASSWORD），否则拒绝启动；只在本机自用可加 -e ARIA_REQUIRE_PASSWORD=0
#
# 国内构建慢可以换源：
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#                --build-arg PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple -t ariadne .

# ---------------------------------------------------------------- 前端
FROM node:22-slim AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- 后端
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

ARG PYPI_INDEX=https://pypi.org/simple
ENV UV_DEFAULT_INDEX=${PYPI_INDEX} \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    ARIA_DATA_DIR=/data \
    ARIA_FRONTEND_DIST=/app/frontend/dist \
    ARIA_REQUIRE_PASSWORD=1

WORKDIR /app/backend
# 先只装依赖，代码改动时可以复用这一层缓存
COPY backend/pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --no-dev --no-install-project

COPY backend/app ./app
COPY --from=web /src/frontend/dist /app/frontend/dist

# 用普通用户运行；文献库、论文 PDF、设置都在 /data（挂载卷保存）
RUN useradd --create-home --uid 10001 aria \
    && mkdir -p /data && chown aria:aria /data
USER aria
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
