"""生成 docs/architecture.svg（python docs/gen_architecture.py） —— 纯 SVG（SMIL）动画的系统架构图，GitHub README 里用 <img> 可直接播放。"""
import sys
from html import escape

W, H = 1200, 1418
OUT = sys.argv[1] if len(sys.argv) > 1 else str(__import__("pathlib").Path(__file__).with_name("architecture.svg"))

SANS = "'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Noto Sans SC',sans-serif"
MONO = "'JetBrains Mono','Cascadia Code',Consolas,'SFMono-Regular',Menlo,monospace"
SERIF = "'Noto Serif CJK SC','Songti SC','STSong',Georgia,serif"

C = {
    "ink": "#1f2328", "fg": "#4a4f57", "mute": "#8a9099", "wire": "#9aa3ad",
    "blue": ("#4a90d9", "#eef5fd", "#1f5fa8"),
    "orange": ("#e3944d", "#fdf3e7", "#b35c17"),
    "purple": ("#8f7ad6", "#f3effc", "#5b45b0"),
    "green": ("#5bb07a", "#ebf7ef", "#2b7a48"),
    "gray": ("#b4bac3", "#f6f7f9", "#454b54"),
    "pink": ("#e07a8a", "#fdf0f2", "#b3384d"),
}

out: list[str] = []
add = out.append


def t(x, y, s, size=14, color=None, weight=400, anchor="start", font=SANS, extra=""):
    add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color or C["fg"]}" font-weight="{weight}" '
        f'text-anchor="{anchor}" font-family="{font}" {extra}>{escape(s)}</text>')


def box(x, y, w, h, tone, r=14, dash=False, sw=1.6, fill=None, extra=""):
    s, f, _ = C[tone]
    d = ' stroke-dasharray="6 5"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill or f}" stroke="{s}" stroke-width="{sw}"{d} {extra}/>')


def card(x, y, w, h, tone, title, sub, lines, mono_sub=True):
    s, f, tc = C[tone]
    box(x, y, w, h, tone, extra='filter="url(#shadow)"')
    t(x + 18, y + 30, title, 16, tc, 700)
    if sub:
        t(x + w - 16, y + 30, sub, 11.5, C["mute"], 400, "end", MONO if mono_sub else SANS)
    for i, ln in enumerate(lines):
        add(f'<circle cx="{x + 22}" cy="{y + 55 + i * 23}" r="2.4" fill="{s}"/>')
        t(x + 32, y + 60 + i * 23, ln, 13, C["fg"])


def wire(d, color=None, arrow=True, width=1.6, dash=None):
    m = ' marker-end="url(#arrow)"' if arrow else ""
    da = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<path d="{d}" fill="none" stroke="{color or C["wire"]}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"{da}{m}/>')


def packet(d, color, dur, begin=0.0, r=4.6):
    """沿导线流动的数据包：发光的头 + 两颗渐淡的尾巴"""
    for k, (rr, op) in enumerate([(r, 1), (r * 0.72, 0.5), (r * 0.5, 0.25)]):
        b = begin - k * 0.07
        add(f'<circle r="{rr:.2f}" fill="{color}" opacity="{op}" filter="url(#glow)">'
            f'<animateMotion dur="{dur}s" begin="{b:.2f}s" repeatCount="indefinite" path="{d}" calcMode="linear"/></circle>')


def pill(x, y, w, h, tone, label, desc, mono=True):
    s, f, tc = C[tone]
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h / 2}" fill="#fff" stroke="{s}" stroke-opacity=".55"/>')
    t(x + 14, y + h / 2 + 4.5, label, 12.5, tc, 600, font=MONO if mono else SANS)
    t(x + w - 14, y + h / 2 + 4.5, desc, 12.5, C["fg"], 400, "end")


# ------------------------------------------------------------------ 头部
add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
    f'aria-label="Ariadne 研究报告助手 系统架构（动态）">')
add("""<defs>
<filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.6" result="b"/>
<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="shadow" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#1f2328" flood-opacity=".06"/></filter>
<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M1,1.5 L8.5,5 L1,8.5" fill="none" stroke="#9aa3ad" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrowP" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M1,1.5 L8.5,5 L1,8.5" fill="none" stroke="#8f7ad6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#fbfaf8"/></linearGradient>
</defs>""")

# 窗口外框
add(f'<rect x="6" y="6" width="{W - 12}" height="{H - 12}" rx="20" fill="url(#bg)" stroke="#e3e5e8" stroke-width="1.5"/>')
add(f'<path d="M6,50 H{W - 6}" stroke="#eceef1"/>')
for i, col in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
    add(f'<circle cx="{32 + i * 22}" cy="28" r="6.5" fill="{col}"/>')
t(W / 2, 33, "~/Ariadnian-agent — architecture", 12.5, C["mute"], 400, "middle", MONO)

# 标题
add(f'<text x="{W / 2}" y="112" text-anchor="middle" font-family="{SERIF}" font-weight="700">'
    f'<tspan font-size="50" fill="#0078d4" font-style="italic">Ariadne</tspan>'
    f'<tspan font-size="44" fill="{C["ink"]}" dx="14">的系统架构</tspan></text>')
add('<rect x="545" y="128" width="34" height="5" rx="1" fill="#1f2328"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1.1s" repeatCount="indefinite"/></rect>')
t(W / 2, 160, "你自己写 · AI 在旁边帮忙 · 每一处引用都能追溯到原文", 15, C["mute"], 400, "middle")

add('<g transform="translate(0,46)">')

# ------------------------------------------------------------------ 用户
box(440, 135, 320, 66, "pink", extra='filter="url(#shadow)"')
add('<circle cx="482" cy="168" r="17" fill="#fff" stroke="#e07a8a" stroke-width="1.5"/>'
    '<circle cx="482" cy="162" r="5.5" fill="#e07a8a"/><path d="M472,177 q10,-11 20,0" fill="#e07a8a"/>')
t(512, 162, "你（写作者）", 16, C["pink"][2], 700)
t(512, 184, "在编辑器里写，随时调用 AI", 12.5, C["fg"])
wire("M600,201 V246")
packet("M600,201 V246", C["pink"][0], 1.2)

# ------------------------------------------------------------------ 前端
box(40, 250, 1120, 222, "blue", r=18, dash=True, fill="#fafcff")
t(64, 279, "前端 frontend", 15, C["blue"][2], 700)
t(184, 279, "React 19 · Vite · MUI 7 · TipTap 3", 12, C["mute"], 400, font=MONO)

card(70, 296, 340, 156, "blue", "编辑器", "TipTap", [
    "Citation 引用节点 · @ 插入引用",
    "GhostText 行内续写（Tab 接受）",
    "选区浮动菜单 · 修订模式 diff",
    "悬浮目录 / 短横线大纲",
])
# 续写光标闪烁
add('<rect x="288" y="371" width="1.8" height="15" fill="#4a90d9"><animate attributeName="opacity" values="1;1;0;0" keyTimes="0;.5;.5;1" dur="1s" repeatCount="indefinite"/></rect>')

card(430, 296, 340, 156, "blue", "页边批注", "ReviewMarks", [
    "停笔后逐段检查（段落 hash 缓存）",
    "缺引用的论断 → 候选文献",
    "撑不起论断的引用 → 换一篇",
    "卡片与句子对齐，一键接受",
])
# 波浪线下划线：模拟批注
add('<path d="M452,436 q4,-4 8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0 t8,0" fill="none" stroke="#e3944d" stroke-width="1.4" stroke-dasharray="100" stroke-dashoffset="100">'
    '<animate attributeName="stroke-dashoffset" values="100;0;0;100" keyTimes="0;.3;.85;1" dur="5s" repeatCount="indefinite"/></path>')

card(790, 296, 340, 156, "blue", "助手抽屉", "Ctrl+J", [
    "综述 Agent · 找引用",
    "文献问答 · 文献库 · 我的论文",
    "设置：模型 / 检索 / 用量统计",
    "参考文献 GB/T 7714 · APA 自动生成",
])

# 前端 → 后端
t(780, 498, "HTTP · SSE 流式返回", 12, C["mute"], 400, "middle", MONO)
wire("M232,452 V540")
wire("M252,540 V452")
wire("M600,452 V488 H420 V540")
wire("M960,452 V540")
packet("M232,452 V540", C["blue"][0], 1.4)
packet("M252,540 V452", C["orange"][0], 1.4, -0.7)
packet("M600,452 V488 H420 V540", C["blue"][0], 1.8, -0.4)
packet("M960,452 V540", C["purple"][0], 1.6, -0.2)

# ------------------------------------------------------------------ 后端
box(40, 516, 1120, 762, "gray", r=18, dash=True, fill="#fdfdfd")
t(64, 545, "后端 backend", 15, C["gray"][2], 700)
t(176, 545, "FastAPI · uvicorn", 12, C["mute"], 400, font=MONO)

# 快速路径
box(70, 560, 430, 300, "orange", extra='filter="url(#shadow)"')
t(90, 592, "快速路径", 16, C["orange"][2], 700)
t(166, 592, "直接调用模型 · 几百毫秒响应", 12.5, C["fg"])
rows = [
    ("/complete", "行内续写"),
    ("/edit  SSE", "选中改写"),
    ("/cite · /verify", "找引用 · 判断是否支撑"),
    ("/annotate", "页边批注"),
    ("/ask  SSE", "文献问答（带 [n] 来源）"),
]
for i, (a, b) in enumerate(rows):
    y = 610 + i * 46
    pill(90, y, 390, 34, "orange", a, b)
    # 当前处理的请求依次亮起
    add(f'<rect x="90" y="{y}" width="390" height="34" rx="17" fill="none" stroke="#e3944d" stroke-width="2.2" opacity="0">'
        f'<animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.04;.16;.2;1" dur="6s" begin="{i * 1.2}s" repeatCount="indefinite"/></rect>')

# Agent 路径
AX, AY, AW, AH = 530, 560, 600, 300
box(AX, AY, AW, AH, "purple", extra='filter="url(#shadow)"')
t(550, 592, "Agent 路径", 16, C["purple"][2], 700)
t(642, 592, "LangGraph · interrupt() 人工确认 · SQLite checkpointer", 12, C["fg"])

NW, NH = 124, 46
xs = [552, 697, 842, 987]
r1, r2 = 630, 728
row1 = ["plan_queries", "search_papers", "select_papers", "ingest"]
row2 = ["synthesize", "make_outline", "review_outline", "finish"]
zh1 = ["拆解检索式", "检索文献", "勾选文献", "下载 · 切块"]
zh2 = ["综合要点", "生成大纲", "确认大纲", "写入文档"]
nodes = []  # (name, zh, x, y, pause)
for i in range(4):
    nodes.append((row1[i], zh1[i], xs[i], r1, row1[i] == "select_papers"))
for i in range(4):
    nodes.append((row2[i], zh2[i], xs[3 - i], r2, row2[i] == "review_outline"))

# 令牌路径（画在节点下面，只在节点之间露出来）
cx = lambda x: x + NW / 2
pts = [(cx(n[2]), n[3] + NH / 2) for n in nodes]
tok_path = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
for a, b in zip(pts, pts[1:]):
    if a[1] == b[1]:
        x1 = a[0] + (NW / 2 if b[0] > a[0] else -NW / 2)
        x2 = b[0] - (NW / 2 if b[0] > a[0] else -NW / 2)
        add(f'<path d="M{x1:.1f},{a[1]:.1f} L{x2:.1f},{b[1]:.1f}" stroke="#b9acea" stroke-width="1.6" marker-end="url(#arrowP)"/>')
    else:
        add(f'<path d="M{a[0]:.1f},{a[1] + NH / 2:.1f} L{b[0]:.1f},{b[1] - NH / 2:.1f}" stroke="#b9acea" stroke-width="1.6" marker-end="url(#arrowP)"/>')

# 调度：节点停留时间，暂停节点停得久
dwell = [0.35, 0.35, 1.9, 0.35, 0.35, 0.35, 1.9, 0.9]
speed = 230.0
segs = [abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in zip(pts, pts[1:])]
total_len = sum(segs)
times, kp = [], []
tnow, lnow = 0.0, 0.0
arrive = []
for i in range(len(pts)):
    arrive.append(tnow)
    times += [tnow, tnow + dwell[i]]
    kp += [lnow / total_len, lnow / total_len]
    tnow += dwell[i]
    if i < len(segs):
        tnow += segs[i] / speed
        lnow += segs[i]
T = tnow + 0.4
times.append(T)
kp.append(1.0)
kt = ";".join(f"{x / T:.4f}" for x in times)
kps = ";".join(f"{x:.4f}" for x in kp)
add(f'<circle r="6" fill="#8f7ad6" filter="url(#glow)"><animateMotion dur="{T:.2f}s" repeatCount="indefinite" path="{tok_path}" '
    f'keyTimes="{kt}" keyPoints="{kps}" calcMode="linear"/></circle>')

for i, (name, zh, x, y, pause) in enumerate(nodes):
    tone = "orange" if pause else "purple"
    s, f, tc = C[tone]
    add(f'<rect x="{x}" y="{y}" width="{NW}" height="{NH}" rx="10" fill="#fff" stroke="{s}" stroke-opacity=".7" stroke-width="1.3"/>')
    # 激活高亮
    a0 = arrive[i] / T
    a1 = (arrive[i] + dwell[i]) / T
    pre, post = max(0, a0 - 0.012), min(1, a1 + 0.03)
    kts = sorted({0, pre, a0, a1, post, 1})
    vals = {0: 0, pre: 0, a0: 1, a1: 1, post: 0, 1: 0}
    if a0 == 0:
        vals[0] = 1
    add(f'<rect x="{x}" y="{y}" width="{NW}" height="{NH}" rx="10" fill="{f}" stroke="{s}" stroke-width="2.4" opacity="0">'
        f'<animate attributeName="opacity" values="{";".join(str(vals[k]) for k in kts)}" keyTimes="{";".join(f"{k:.4f}" for k in kts)}" '
        f'dur="{T:.2f}s" repeatCount="indefinite"/></rect>')
    t(x + NW / 2, y + 19, name, 11.5, tc, 600, "middle", MONO)
    t(x + NW / 2, y + 36, zh, 12, C["fg"], 400, "middle")
    if pause:
        bx, by = x + NW - 4, y + 2
        add(f'<circle cx="{bx}" cy="{by}" r="10" fill="none" stroke="#e3944d" stroke-width="2">'
            f'<animate attributeName="r" values="9;17" dur="1.6s" repeatCount="indefinite"/>'
            f'<animate attributeName="opacity" values=".8;0" dur="1.6s" repeatCount="indefinite"/></circle>')
        add(f'<circle cx="{bx}" cy="{by}" r="9.5" fill="#e3944d"/>'
            f'<rect x="{bx - 3.6}" y="{by - 4}" width="2.4" height="8" fill="#fff"/><rect x="{bx + 1.2}" y="{by - 4}" width="2.4" height="8" fill="#fff"/>')

# 重写大纲的回环（review_outline → make_outline）
rx_from = xs[1] + NW / 2  # review_outline 在 xs[1]
rx_to = xs[2] + NW / 2    # make_outline 在 xs[2]
add(f'<path d="M{rx_from},{r2 + NH} C{rx_from},{r2 + NH + 34} {rx_to},{r2 + NH + 34} {rx_to},{r2 + NH + 4}" fill="none" stroke="#e3944d" '
    f'stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#arrow)"><animate attributeName="stroke-dashoffset" values="18;0" dur=".9s" repeatCount="indefinite"/></path>')
t((rx_from + rx_to) / 2, r2 + NH + 44, "不满意 → 重写大纲", 11.5, C["orange"][2], 500, "middle")
# 图例
add(f'<circle cx="{AX + 32}" cy="{AY + AH - 23}" r="7" fill="#e3944d"/><rect x="{AX + 29.3}" y="{AY + AH - 26}" width="1.9" height="6" fill="#fff"/><rect x="{AX + 32.9}" y="{AY + AH - 26}" width="1.9" height="6" fill="#fff"/>')
t(AX + 46, AY + AH - 18.5, "暂停等你确认 · 刷新页面、重启服务都能接着跑", 11.5, C["fg"])

# 两条路径 → LLM 接入层
wire("M285,860 V892")
wire("M830,860 V892")
packet("M285,860 V892", C["orange"][0], 0.9)
packet("M830,860 V892", C["purple"][0], 0.9, -0.45)

# ------------------------------------------------------------------ LLM 接入层
box(70, 896, 1060, 150, "green", extra='filter="url(#shadow)"')
t(90, 926, "LLM 接入层", 16, C["green"][2], 700)
t(184, 926, "llm.py · LiteLLM 统一接口", 12.5, C["fg"], 400, font=MONO)
tiers = [("complete", "续写 · 8s 超时"), ("write", "改写 · 问答"), ("judge", "引用判断 · 批注"), ("agent", "综述规划")]
for i, (k, v) in enumerate(tiers):
    x = 90 + i * 172
    add(f'<rect x="{x}" y="944" width="160" height="50" rx="10" fill="#fff" stroke="#5bb07a" stroke-opacity=".6"/>')
    add(f'<rect x="{x}" y="944" width="160" height="50" rx="10" fill="#ebf7ef" stroke="#5bb07a" stroke-width="2.2" opacity="0">'
        f'<animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;.05;.2;.26;1" dur="4.8s" begin="{i * 1.2}s" repeatCount="indefinite"/></rect>')
    t(x + 80, 965, k, 13, C["green"][2], 700, "middle", MONO)
    t(x + 80, 984, v, 12, C["fg"], 400, "middle")
t(90, 1026, "按档设置超时 / 重试 / 备用模型 · JSON 模式不支持时自动降级 · 每次调用记入 llm_calls", 12, C["mute"])
# 服务商
t(800, 926, "可换任意服务商（网页里设置）", 12, C["mute"])
provs = ["DeepSeek", "通义千问", "Kimi", "智谱 GLM", "硅基流动", "OpenAI", "Ollama"]
px, py = 800, 940
for i, p in enumerate(provs):
    w = 14 + len(p.encode("gbk")) * 6.4
    if px + w > 1112:
        px, py = 800, py + 32
    add(f'<rect x="{px}" y="{py}" width="{w:.0f}" height="24" rx="12" fill="#fff" stroke="#c9d2cc"/>')
    t(px + w / 2, py + 16.5, p, 12, C["fg"], 400, "middle")
    px += w + 8

# ------------------------------------------------------------------ 共享层
t(70, 1078, "共享层", 14, C["gray"][2], 700)
t(124, 1078, "两条路径共用同一个文献库", 12.5, C["mute"])
card(70, 1092, 330, 166, "blue", "混合检索", "retrieval", [
    "BM25（jieba 分词）",
    "+ 可选向量检索 → RRF 融合",
    "中文论断 → 英文关键词扩展",
    "返回原文片段（章节 · 页码）",
])
card(435, 1092, 330, 166, "gray", "SQLite", "data/", [
    "papers · chunks（按章节切块）",
    "documents · agent_threads",
    "checkpoints（断点续跑）",
    "llm_calls · search_cache",
])
card(800, 1092, 330, 166, "orange", "文献检索", "scholar.py", [
    "Semantic Scholar · arXiv · OpenAlex",
    "按来源限速 · 结果缓存",
    "429 退避重试 → 换 OpenAlex",
    "下载 PDF → PyMuPDF 解析",
])
wire("M400,1175 H435", arrow=True)
wire("M800,1175 H765", arrow=True)
t(417.5, 1166, "读", 11, C["mute"], 400, "middle")
t(782.5, 1166, "入库", 11, C["mute"], 400, "middle")
packet("M435,1175 H400", C["blue"][0], 1.0)
packet("M800,1175 H765", C["orange"][0], 1.0, -0.5)

# 侧边总线：快速路径 → 混合检索，Agent → 文献检索
wire("M70,700 H54 V1175 H70")
wire("M1130,700 H1146 V1175 H1130")
packet("M70,700 H54 V1175 H70", C["orange"][0], 3.2)
packet("M1130,700 H1146 V1175 H1130", C["purple"][0], 3.2, -1.6)

add("</g>")

# ------------------------------------------------------------------ 总结
add(f'<rect x="40" y="1340" width="1120" height="58" rx="14" fill="#fffaf0" stroke="#f0dcb4"/>')
add('<circle cx="76" cy="1369" r="13" fill="#ffd970"><animate attributeName="opacity" values=".55;1;.55" dur="2.4s" repeatCount="indefinite"/></circle>'
    '<circle cx="76" cy="1369" r="20" fill="#ffd970" opacity=".25" filter="url(#soft)"/>'
    '<rect x="71" y="1380" width="10" height="6" rx="1.5" fill="#c9a24a"/>')
t(104, 1365, "快速路径管写作时的即时反馈；Agent 路径管需要你确认的长任务。", 14, C["ink"], 500)
t(104, 1386, "两条路径共用同一个文献库，模型可在网页里随时切换，所有引用都对照原文核查。", 13, C["fg"])

add("</svg>")
open(OUT, "w", encoding="utf-8").write("\n".join(out))
print("written", OUT, f"agent cycle {T:.2f}s")
