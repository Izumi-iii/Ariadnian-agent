# Ariadne · 研究报告助手

<p align="center"><img src="./frontend/public/ariadne-512.png" width="128" alt="Ariadne"/></p>

一个写研究报告和论文用的编辑器：**你自己写，AI 在旁边帮忙**（界面沿用 Alidade 的设计语言）：文献检索与管理、带出处的引用插入、Copilot 式续写、选中改写，以及一个会在关键步骤停下来等你确认的「文献综述 → 大纲」Agent。

> 名字来自阿里阿德涅之线 —— 在文献的迷宫里牵一根线，每一处引用都能追溯到原文。

![主界面：左侧目录、正文、右侧页边批注](docs/screenshots/editor.png)

## 功能

| 功能 | 怎么用 | 实现要点 |
|---|---|---|
| **行内续写建议** | 停顿约 0.7 秒出现灰色建议；`Tab` 接受，`Ctrl+→` 接受一个词，`Esc` 忽略 | 防抖 + AbortController 取消过期请求；走快模型，不经过 Agent |
| **选中改写** | 选中文字 → 润色 / 学术化 / 改写 / 扩写 / 精简 / 译英 / 译中 / 自定义 | 流式输出，修订模式 diff，逐次接受或放弃；改写时保留引用标记 |
| **插入引用** | 正文输入 `@` 搜索文献库；或文献库条目上的 ❞ 按钮 | 引用是独立的 citation 节点，绑定文献库 id |
| **为一句话找引用** | 选中文字，在浮动菜单里点「找引用」 | 混合检索 + LLM 判断「支持 / 部分支持 / 不相关」，并给出原文片段 |
| **页边批注** | 默认开启（顶栏 ✎ 图标切换）；写完一段、光标离开后自动检查 | 逐段调用 `/api/assist/annotate`：核查已有引用、找出缺引用的论断并给出候选文献、至多一条精简建议；结果按段落内容缓存，正文用波浪线/虚线标出，卡片与句子对齐 |
| **整篇引用核查** | 助手抽屉「找引用」→ 核查全文引用 | 逐条检查被引文献原文能否支撑那句话，能找出凭空挂上的引用 |
| **参考文献自动生成** | 无需操作 | 顺序编码（GB/T 7714 简化）/ 作者-年份（APA）一键切换 |
| **文献库** | 在线检索 Semantic Scholar / arXiv / OpenAlex、上传 PDF、下载开放获取全文 | PyMuPDF 解析，按章节切块（记录章节和页码），遇到参考文献就停止 |
| **文献问答** | 助手抽屉「文献问答」 | 回答带 [n] 来源，可一键插入正文并自动转换成引用 |
| **综述 Agent** | 助手抽屉「综述 Agent」填主题 → 勾选文献 → 修改/确认大纲 → 写入文档 | LangGraph + `interrupt()` 人工确认 + SQLite checkpointer（刷新页面、重启服务都能恢复） |
| **导出** | 顶栏「导出」 | LaTeX + refs.bib（可直接传 Overleaf）、Markdown（pandoc 引用语法）、BibTeX |

**防止编造引用**是贯穿各个功能的原则：大纲里的 bibkey 会和文献库核对，库里没有的直接丢弃；改写结果里的 `[@key]` 只有在文献库中存在才会变回引用；引用核查会对照被引文献的原文逐条检查。

## 界面

> 以下截图来自系统实际运行画面，在**离线演示模式**（`npm run demo`，`LLM_FAKE=1`）下拍摄：界面和操作流程是真实的，文献元数据是真实论文，但 AI 给出的判断、改写和大纲是演示数据（卡片上标有「离线演示」）。接入模型后内容由模型生成。

**页边批注**（见页首截图）：停笔后逐段检查，缺引用的论断、可能撑不起论断的引用、可以精简的句子直接贴在段落旁边，一键插入候选文献或接受改写。

<table>
<tr>
<td width="50%"><b>@ 插入引用</b>：正文里输入 <code>@</code> 搜索文献库<br/><img src="docs/screenshots/cite-at.png" alt="@ 插入引用"/></td>
<td width="50%"><b>选中改写</b>：修订模式显示增删，接受或放弃<br/><img src="docs/screenshots/rewrite.png" alt="选中改写"/></td>
</tr>
</table>

**综述 Agent**：输入主题后检索文献，在「勾选文献」和「确认大纲」两处停下来等你确认；打开抽屉时左侧目录缩成短横线，鼠标移上去即可预览章节。

<table>
<tr>
<td width="50%"><img src="docs/screenshots/agent-papers.png" alt="综述 Agent：勾选文献"/></td>
<td width="50%"><img src="docs/screenshots/agent-outline.png" alt="综述 Agent：确认大纲，短横线目录悬停预览"/></td>
</tr>
<tr>
<td><b>找引用</b>：为一句论断检索文献，给出「支持 / 部分支持」判断和原文片段<br/><img src="docs/screenshots/find-citations.png" alt="找引用"/></td>
<td><b>设置</b>：在网页里选模型服务商、填 API Key、测试连接，无需改 .env<br/><img src="docs/screenshots/settings.png" alt="设置"/></td>
</tr>
</table>

正文始终在视野中心；目录悬浮在左侧页边，打开抽屉或窗口变窄时缩成一列短横线（1/2/3 级标题长短不同，当前章节蓝色高亮，鼠标移上去立即预览标题和正文开头，点击跳转）；AI 助手平时收起，左侧图标栏或 `Ctrl+J` 打开。

## 架构

<p align="center"><img src="docs/architecture.svg" width="100%" alt="Ariadne 系统架构（动态）"/></p>

<details>
<summary>文字版（模块与接口）</summary>

```
frontend/  React 19 + Vite + MUI 7 + TipTap 3
  ├─ 编辑器：Citation 节点 / @ 引用建议 / GhostText 续写 / 选区浮动菜单 + diff / 悬浮目录
  ├─ 页边批注：段落 hash 缓存 → /api/assist/annotate → 正文装饰（ReviewMarks）+ 对齐的卡片
  └─ 助手抽屉：综述 Agent · 找引用 · 文献问答 · 文献库 · 我的论文
        │   /api（开发时由 Vite 代理）
        ▼
backend/   FastAPI
  ├─ LLM 接入层 llm.py：LiteLLM，四档模型 complete / write / judge / agent，各自的超时、重试、备用模型，调用日志
  ├─ 快速路径（直接调用 LLM，低延迟）：/api/assist/complete · edit(SSE) · cite · verify · annotate · ask(SSE)
  ├─ Agent 路径：/api/agent/start · /{id}/resume（SSE） → LangGraph
  │     plan_queries → search_papers → select_papers⏸ → ingest → synthesize → make_outline → review_outline⏸ → finish
  │                                                                              ▲──────── regenerate ────────┘
  └─ 共享：SQLite（文献、切块、文档）· BM25(jieba) + 可选向量的 RRF 混合检索 · 跨语言查询扩展
```

</details>

为什么把两条路径分开：续写、改写这些操作要求几百毫秒内响应，直接调用模型；综述这类长任务要中途暂停、等用户确认、断点续跑，这部分交给 LangGraph。

## 快速开始

需要 [uv](https://docs.astral.sh/uv/getting-started/installation/)（Windows 可用 `winget install astral-sh.uv`）和 Node.js ≥ 20。所有命令都在仓库根目录执行：

```bash
npm run setup     # 第一次：安装前后端依赖，并生成 backend/.env
npm run dev       # 开发：后端 :8000 + 前端 :5173 一起启动，热更新，自动打开浏览器，Ctrl+C 一起退出
```

| 命令 | 作用 |
|---|---|
| `npm run setup` | `uv sync` + `npm install`，没有 `backend/.env` 时从 `.env.example` 生成 |
| `npm run dev` | 开发模式，前后端同时启动 |
| `npm run demo` | 同上，但设置 `LLM_FAKE=1`：不调用模型、不需要 API key，适合演示和调界面 |
| `npm start` | 生产模式：前端有改动才重新构建，由后端单端口提供服务 http://localhost:8000 |
| `npm test` | 后端测试（20 个，离线）+ 前端类型检查 |

依赖没装时 `dev` / `demo` / `start` 会自动先执行一次 `setup`。设置环境变量 `NO_OPEN=1` 可以不自动打开浏览器，`PORT` 可以修改 `npm start` 的端口。

## 配置要点

**推荐在网页里配置**：右上角 ⚙ 打开「设置」，可以配置模型（选服务商预设、填 API Key、主模型和快模型，高级里还能按四档分别配置）、文献检索（Semantic Scholar / OpenAlex 的 key、默认来源、缓存天数）、向量检索，并查看各档模型的用量统计。每一项都有「测试」按钮，保存后立即生效，不用重启。

- 网页里保存的设置写在本机 `backend/data/settings.json`，**优先于 `.env`**；网页里没设置的项继续读 `.env`，所以原来的 `.env` 配置照样可用。
- API Key 只写不读：接口只返回是否已设置和末 4 位，测试失败时报错信息里的 key 也会被遮住。
- 第一次打开、还没配置模型时，会自动弹出设置页。

也可以继续用 `.env`（适合部署或脚本化），字段说明见 `backend/.env.example`：

- **模型（LiteLLM）**：模型名写成 `provider/model`，例如 `deepseek/deepseek-chat`、`openai/qwen-plus`（OpenAI 兼容服务，需同时填 `LLM_API_BASE`）、`ollama_chat/qwen2.5:7b`，Claude、Gemini 等原生接口也能用。按任务分四档：

  | 档位 | 环境变量 | 用途 | 默认超时 |
  |---|---|---|---|
  | complete | `MODEL_COMPLETE` | 行内续写，延迟最敏感 | 8 s，不重试 |
  | write | `MODEL_WRITE` | 选中改写、文献问答 | 90 s |
  | judge | `MODEL_JUDGE` | 引用判断、中文→英文检索关键词 | 30 s |
  | agent | `MODEL_AGENT` | 综述与大纲（JSON 输出） | 180 s |

  没单独配置的档位使用 `MODEL_ID` / `FAST_MODEL_ID`。每档还可以配置 `_API_KEY`、`_API_BASE`、`_TIMEOUT`、`_FALLBACKS`（备用模型）。旧版的 `MODEL_PROVIDER` + `OPENAI_API_KEY` + `OPENAI_BASE_URL` 配置仍然有效。每次调用的耗时、首 token 延迟、token 数和费用都会记录下来，在右上角「模型设置」里查看（接口为 `/api/llm/stats`）。
- **中文写作 + 英文文献**：系统会把中文句子转换成英文关键词，再和原句一起检索。条件允许的话，建议再开启多语言向量模型（例如 `EMBEDDING_PROVIDER=ollama`、`EMBEDDING_MODEL=bge-m3`）。
- **学术检索与限流**：Semantic Scholar 不配 key 时与所有匿名用户共享配额，高峰期经常返回 429，强烈建议免费申请 `SEMANTIC_SCHOLAR_API_KEY`。检索层会自动处理：同一来源的请求限速（S2 每秒 1 次、arXiv 3 秒 1 次），429/5xx 按 Retry-After 或指数退避重试 3 次，仍失败就冷却 60 秒并改用 OpenAlex 补位（可选 `OPENALEX_API_KEY`），结果缓存 7 天（`SEARCH_CACHE_DAYS`）。

## 目录

```
backend/
  app/
    main.py            FastAPI 入口
    routers/settings.py  网页设置：读取 / 保存（settings.json 覆盖 .env）、测试模型连接与检索来源
    config.py          .env 配置（兼容旧版字段）
    llm.py             LiteLLM 接入层：四档模型、JSON 模式、备用模型、调用统计、LLM_FAKE
    db.py              SQLite 表结构
    library.py         文献元数据、去重、bibkey、BibTeX
    ingest.py          PDF 解析与按章节切块
    retrieval.py       BM25 + 向量 RRF 混合检索
    embeddings.py      可选嵌入（Ollama / OpenAI）
    scholar.py         Semantic Scholar / arXiv / OpenAlex 检索：限速、429 重试、自动补位、结果缓存；PDF 下载
    assist.py          续写、改写、找引用、核查、问答
    agent/graph.py     LangGraph 综述→大纲工作流
    routers/           API 路由
  tests/
package.json         一键命令（setup / dev / demo / start / test）
scripts/             启动脚本，只用 Node 内置模块，Windows / macOS / Linux 通用
frontend/
  src/
    editor/            TipTap 编辑器与扩展（引用节点、@ 引用、灰色续写、选区改写、页边批注、悬浮目录）
    panels/            右侧抽屉：综述 Agent / 找引用 / 文献问答 / 文献库 / 我的论文
    components/        时间线卡片、输入框、设置页（模型 / 文献检索 / 向量检索 / 用量）
    lib/               API、引用格式化、导出、页边批注的段落缓存与定位
```

## 路线图

- [ ] 分节写作 Agent：按大纲逐节生成草稿，每节单独检索，写完自动跑一遍引用核查
- [ ] 审稿 Agent：模拟审稿人挑逻辑和论据问题，带有限轮次的修改循环
- [ ] 评测集：统计虚假引用率、引用支撑率，对比开启/关闭核查的效果
- [ ] GROBID / MinerU 解析，提升双栏排版和中文 PDF 的解析质量
- [ ] docx 导出（pandoc）、图表与公式节点
