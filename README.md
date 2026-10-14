# Ariadne · 论文写作助手

<p align="center"><img src="./frontend/public/ariadne-icon.svg" width="96" alt="Ariadne"/></p>

一个**你自己写、AI 在旁边帮忙**的论文编辑器（界面沿用 Alidade 的设计语言）：文献检索与管理、带出处的引用插入、Copilot 式续写、选中改写，以及一个会在关键步骤停下来等你确认的「文献综述 → 大纲」Agent。

> 名字来自阿里阿德涅之线 —— 在文献的迷宫里牵一根线，每一处引用都能追溯到原文。

## 功能

| 功能 | 怎么用 | 实现要点 |
|---|---|---|
| **行内续写建议** | 停顿约 0.7 秒出现灰色建议；`Tab` 接受，`Ctrl+→` 接受一个词，`Esc` 忽略 | 防抖 + AbortController 取消过期请求；走快模型，不经过 Agent |
| **选中改写** | 选中文字 → 润色 / 学术化 / 改写 / 扩写 / 精简 / 译英 / 译中 / 自定义 | 流式输出，修订模式 diff，逐次接受或放弃；改写时保留引用标记 |
| **插入引用** | 正文输入 `@` 搜索文献库；或文献库条目上的 ❞ 按钮 | 引用是独立的 citation 节点，绑定文献库 id |
| **为一句话找引用** | 选中文字点「找引用」，或工具栏 🔍 | 混合检索 + LLM 判断「支持 / 部分支持 / 不相关」，并给出原文片段 |
| **整篇引用核查** | 右侧「引用」→ 开始核查 | 逐条检查被引文献原文能否支撑那句话，能找出凭空挂上的引用 |
| **参考文献自动生成** | 无需操作 | 顺序编码（GB/T 7714 简化）/ 作者-年份（APA）一键切换 |
| **文献库** | 在线检索 arXiv + Semantic Scholar、上传 PDF、下载开放获取全文 | PyMuPDF 解析，按章节切块（记录章节和页码），遇到参考文献就停止 |
| **文献问答** | 右侧「文献问答」 | 回答带 [n] 来源，可一键插入正文并自动转换成引用 |
| **综述 Agent** | 右侧「综述 Agent」填主题 → 勾选文献 → 修改/确认大纲 → 写入文档 | LangGraph + `interrupt()` 人工确认 + SQLite checkpointer（刷新页面、重启服务都能恢复） |
| **导出** | 顶栏「导出」 | LaTeX + refs.bib（可直接传 Overleaf）、Markdown（pandoc 引用语法）、BibTeX |

**防止编造引用**是贯穿各个功能的原则：大纲里的 bibkey 会和文献库核对，库里没有的直接丢弃；改写结果里的 `[@key]` 只有在文献库中存在才会变回引用；引用核查会对照被引文献的原文逐条检查。

## 架构

```
frontend/  React 19 + Vite + MUI 7 + TipTap 3
  ├─ 编辑器：Citation 节点 / @ 引用建议 / GhostText 续写 / 选区浮动菜单 + diff
  └─ 侧栏：我的论文 · 文献库 · 综述 Agent · 引用 · 文献问答
        │   /api（开发时由 Vite 代理）
        ▼
backend/   FastAPI
  ├─ LLM 接入层 llm.py：LiteLLM，四档模型 complete / write / judge / agent，各自的超时、重试、备用模型，调用日志
  ├─ 快速路径（直接调用 LLM，低延迟）：/api/assist/complete · edit(SSE) · cite · verify · ask(SSE)
  ├─ Agent 路径：/api/agent/start · /{id}/resume（SSE） → LangGraph
  │     plan_queries → search_papers → select_papers⏸ → ingest → synthesize → make_outline → review_outline⏸ → finish
  │                                                                              ▲──────── regenerate ────────┘
  └─ 共享：SQLite（文献、切块、文档）· BM25(jieba) + 可选向量的 RRF 混合检索 · 跨语言查询扩展
```

为什么把两条路径分开：续写、改写这些操作要求几百毫秒内响应，直接调用模型；综述这类长任务要中途暂停、等用户确认、断点续跑，这部分交给 LangGraph。

## 快速开始

需要 Python ≥ 3.11、[uv](https://github.com/astral-sh/uv)、Node.js ≥ 20。

```bash
# 1. 后端
cd backend
copy .env.example .env        # macOS/Linux: cp .env.example .env，然后填 OPENAI_API_KEY 等
uv sync
uv run uvicorn app.main:app --reload --port 8000

# 2. 前端（另开一个终端）
cd frontend
npm install
npm run dev                   # 打开 http://localhost:5173
```

没有 API key 也可以先看效果：在 `.env` 里设 `LLM_FAKE=1`，所有模型调用和学术检索都会返回演示数据。

只想开一个服务：执行 `cd frontend && npm run build`，后端会自动托管 `frontend/dist`，直接访问 http://localhost:8000 即可。

### 测试

```bash
cd backend && uv run pytest -q     # 12 个用例，离线运行（LLM_FAKE），覆盖切块、文献库、PDF、引用核查、Agent 暂停/恢复/重写
```

## 配置要点

- **模型（LiteLLM）**：模型名写成 `provider/model`，例如 `deepseek/deepseek-chat`、`openai/qwen-plus`（OpenAI 兼容服务，需同时填 `LLM_API_BASE`）、`ollama_chat/qwen2.5:7b`，Claude、Gemini 等原生接口也能用。按任务分四档：

  | 档位 | 环境变量 | 用途 | 默认超时 |
  |---|---|---|---|
  | complete | `MODEL_COMPLETE` | 行内续写，延迟最敏感 | 8 s，不重试 |
  | write | `MODEL_WRITE` | 选中改写、文献问答 | 90 s |
  | judge | `MODEL_JUDGE` | 引用判断、中文→英文检索关键词 | 30 s |
  | agent | `MODEL_AGENT` | 综述与大纲（JSON 输出） | 180 s |

  没单独配置的档位使用 `MODEL_ID` / `FAST_MODEL_ID`。每档还可以配置 `_API_KEY`、`_API_BASE`、`_TIMEOUT`、`_FALLBACKS`（备用模型）。旧版的 `MODEL_PROVIDER` + `OPENAI_API_KEY` + `OPENAI_BASE_URL` 配置仍然有效。每次调用的耗时、首 token 延迟、token 数和费用都会记录下来，在右上角「模型设置」里查看（接口为 `/api/llm/stats`）。
- **中文写作 + 英文文献**：系统会把中文句子转换成英文关键词，再和原句一起检索。条件允许的话，建议再开启多语言向量模型（例如 `EMBEDDING_PROVIDER=ollama`、`EMBEDDING_MODEL=bge-m3`）。
- **Semantic Scholar**：不配 key 也能用，但容易被限流。

## 目录

```
backend/
  app/
    main.py            FastAPI 入口
    config.py          .env 配置（兼容旧版字段）
    llm.py             LiteLLM 接入层：四档模型、JSON 模式、备用模型、调用统计、LLM_FAKE
    db.py              SQLite 表结构
    library.py         文献元数据、去重、bibkey、BibTeX
    ingest.py          PDF 解析与按章节切块
    retrieval.py       BM25 + 向量 RRF 混合检索
    embeddings.py      可选嵌入（Ollama / OpenAI）
    scholar.py         arXiv / Semantic Scholar 检索、PDF 下载
    assist.py          续写、改写、找引用、核查、问答
    agent/graph.py     LangGraph 综述→大纲工作流
    routers/           API 路由
  tests/
frontend/
  src/
    editor/            TipTap 编辑器与扩展（引用节点、@ 引用、灰色续写、选区改写）
    panels/            AI 助手（综述 Agent / 找引用 / 文献问答）、文献库、大纲、文档
    components/        时间线卡片、输入框、模型设置
    lib/               API、引用格式化、导出
```

## 路线图

- [ ] 分节写作 Agent：按大纲逐节生成草稿，每节单独检索，写完自动跑一遍引用核查
- [ ] 审稿 Agent：模拟审稿人挑逻辑和论据问题，带有限轮次的修改循环
- [ ] 评测集：统计虚假引用率、引用支撑率，对比开启/关闭核查的效果
- [ ] GROBID / MinerU 解析，提升双栏排版和中文 PDF 的解析质量
- [ ] docx 导出（pandoc）、图表与公式节点
