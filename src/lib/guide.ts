// M25 P1 — built-in「使用指南」Wiki。The guide is a set of editable notes: a main
// index plus topical pages, all interlinked with `[[双链]]` so they behave like a
// small wiki inside the app (searchable, exportable, re-creatable). Content is
// generated from `SHORTCUTS` so the shortcut list stays in sync with the single
// source of truth.
import { SHORTCUTS, shortcutLabel, shortcutGroups } from "./shortcuts";
import { GUIDE_COVER } from "./covers";
import { api } from "./api";
import { useNotes } from "../store/notes";

export const GUIDE_TITLE = "使用指南";
export const GUIDE_ICON = "📖";

export interface GuidePage {
  title: string;
  icon: string;
  blocks: Block[];
  /** Optional parent-page title (defaults to the main index) for nesting the
   *  topical page under another topical page in the tree, e.g. 数学公式 under 编辑器. */
  parent?: string;
}

type Block = Record<string, any>;

// ---- block builders ---------------------------------------------------------
function text(t: string) { return { type: "text", text: t, version: 1 } as any; }
function para(t: string): Block {
  return { type: "paragraph", version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function h(t: string, tag: "h1" | "h2" | "h3"): Block {
  return { type: "heading", tag, version: 1, children: [text(t)], direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function callout(t: string): Block {
  return { type: "callout", version: 1, children: [para(t)], direction: "ltr", format: "", indent: 0, style: "" } as any;
}
function bullet(items: string[]): Block {
  return {
    type: "list", tag: "ul", listType: "bullet", start: 1, version: 1, direction: "ltr", format: "", indent: 0, style: "",
    children: items.map((it) => ({ type: "listitem", version: 1, value: 1, direction: "ltr", format: "", indent: 0, style: "", children: [text(it)] })),
  } as any;
}
function rule(): Block {
  return { type: "horizontalrule", version: 1, direction: "ltr", format: "", indent: 0, style: "" } as any;
}

// Link helper: wrap `[[...]]` for an inter-page wiki link.
function link(title: string): string {
  return `[[${title}]]`;
}

// ---- topical page content ---------------------------------------------------
function quickStart(): Block[] {
  return [
    h("快速开始", "h1"),
    callout("最常用的三件事：新建页面 / 插入内容 / 打开命令面板。"),
    h("新建页面", "h2"),
    bullet([
      `Ctrl+N 新建页面，或用左侧栏的 ＋。`,
      `「新建页面」和「新建文件夹」「新建数据库」在左侧栏下拉里区分。`,
    ]),
    h("插入内容", "h2"),
    bullet([
      `在正文输入 / 打开块菜单：标题、列表、待办、引用、代码、表格、分栏、绘图、图片、书签…`,
      `输入 [[ 可搜标题插入页面双链；输入 (( 插入块引用；输入 {{ 嵌入块。`,
    ]),
    h("打开能力", "h2"),
    bullet([
      `Ctrl+K 命令面板：搜索页面、运行命令、打开使用指南 / 快捷键。`,
      `Ctrl+/ 或 ? 打开快捷键面板。`,
    ]),
    rule(),
    h("下一步", "h2"),
    para(`想了解整体理念 → ${link("核心概念")}；想深入编辑器 → ${link("编辑器")}。`),
  ];
}

function coreConcepts(): Block[] {
  return [
    h("核心概念", "h1"),
    callout("本地优先 · 类 Notion：你的笔记保存在本机（SQLite + 附件目录），离线可用，改动即存，无需手动保存。"),
    h("页面 = 一切", "h2"),
    bullet([
      "页面是最小组织单元，可嵌套层级；页面树在左侧侧边栏。",
      `文件夹 = 网盘：同时承载页面与文件，可拖拽上传、在线预览、搜索、下载、管版本。详见 ${link("文件夹 = 网盘")}。`,
    ]),
    h("结构化：属性 + 数据库", "h2"),
    bullet([
      "给页面加属性（文本/数字/日期/多选/关系…），数据库是「透镜」：同一批页面以表格/画廊/看板/列表/日历/时间轴/目录多视图查看。",
      "看板支持拖拽；视图可保存、可做查询型；支持 ref 关联与公式列。",
    ]),
    h("织网：链接与反链", "h2"),
    bullet([
      `双链：用 ${link("快速开始")} 中提到的 [[标题]] 连接页面；块引用 ((id))、块嵌入 {{id}} 复用内容。`,
      "未链接提及面板可一键把正文里的标题转成双链；关系图展示页面之间的联系。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`熟悉页面后 → ${link("编辑器")}；想搭结构化数据 → ${link("数据库与属性")}。`),
  ];
}

function editor(): Block[] {
  return [
    h("编辑器", "h1"),
    callout("所见即所得块编辑器，基于 Lexical。所有内容都是「块」，可自由拖拽、分栏、内联 AI。"),
    h("块", "h2"),
    bullet([
      "标题 / 段落 / 列表 / 待办 / 引用 / 代码块 / 分隔线。",
      "表格、分栏（/分栏）、绘图（/绘图：Excalidraw + mermaid + AI 文生图）、图片、网址书签。",
      "高级块各有专题：数学公式 / 绘图 / 分栏。",
    ]),
    h("数学公式", "h2"),
    bullet([
      "块级 `/公式`（或 `$$…$$`）渲染为 KaTeX 数学公式；行内 `$…$` 也有内联渲染。",
      "公式编辑器有希腊字母 / 运算符 / 关系式 / 式子 / 箭头 / 化学 六类符号面板；点击公式块即可再次编辑。",
      "左下有 🖼 / ✎：**识别图片中的公式**（上传/拖入/粘贴含公式图片 → 自动转 LaTeX）与**识别手写公式**（手写板书写 → 自动转 LaTeX）——需在 AI 设置配置支持图像的模型。",
      `完整用法与符号示例 → ${link("数学公式")}。`,
    ]),
    h("行内格式", "h2"),
    bullet([
      "选中文字弹出工具条；或输入 / 打开菜单。支持粗体/斜体/下划线/删除线/行内代码。",
      "输入 [[ 触发页面链接建议；输入 (( 块引用；输入 {{ 块嵌入。",
    ]),
    h("拖拽与选择", "h2"),
    bullet([
      "拖动块左侧手柄可移动块；支持跨块选择、块级拖拽。",
    ]),
    h("自动保存", "h2"),
    bullet([
      "无保存按钮，改动即存到本库；版本历史在「存储」或命令面板。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`编辑器内双链已可点击跳转 → ${link("核心概念")}；按 / 插入块，Ctrl+K 找所有能力。`),
  ];
}

function equation(): Block[] {
  return [
    h("数学公式", "h1"),
    callout("块级 / 行内公式，用 LaTeX 书写并渲染为 KaTeX；配 Notion 风格符号面板，还能把图片 / 手写公式自动转成 LaTeX。"),
    h("插入方式", "h2"),
    bullet([
      "块级：输入 `/公式`，或直接写 `$$…$$`（`$$` 中的内容渲染为独立的公式块）。",
      "行内：正文里写 `$…$`（如 `$x^2$`），内嵌在一行文字中；用 `$` 包裹即可。",
    ]),
    h("公式编辑器", "h2"),
    bullet([
      "点击公式块即可再次编辑：Notion 风格的符号面板分 六类（希腊字母 / 运算符 / 关系式 / 式子 / 箭头 / 化学）。",
      "左侧实时预览，`Ctrl+Enter` 提交；主弹窗紧贴公式块下方弹出，符号面板向上展开。",
    ]),
    h("识别图片 / 手写公式", "h2"),
    bullet([
      "`🖼`（编辑器左下）：上传 / 拖入 / 粘贴含公式图片 → 自动转成 LaTeX。",
      "`✎`（编辑器左下）：打开手写板，用笔画出公式 → 自动转成 LaTeX。",
      "识别会**回填到输入框**、可修改后再提交（保留人工确认）；需在 AI 设置中配置支持图像的模型。",
    ]),
    h("示例", "h2"),
    bullet([
      "希腊字母：`\\alpha \\beta \\gamma` → α β γ；`\\Delta` → Δ。",
      "式子：`\\frac{a}{b}`、`x^{2}`、`\\sqrt{x}`、`\\sum_{i=1}^{n}`。",
      "化学：`\\mathrm{H_2O}`、`\\mathrm{CO_2}`。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`公式是编辑器的一种块 → ${link("编辑器")}；想了解整体理念 → ${link("核心概念")}。`),
  ];
}

function drawing(): Block[] {
  return [
    h("绘图", "h1"),
    callout("手绘白板 + 思维导图/流程图 + AI 文生图，都在「绘图」块里。"),
    h("插入画布", "h2"),
    bullet([
      "输入 `/绘图` 插入一个绘图块，点击进入编辑器；支持缩放 / 平移 / 全屏。",
      "手绘：Excalidraw 画布（画笔、形状、文字、箭头、连线），适合草图、白板、结构示意。",
      "文档自动存入页面，图片可导出；离线可用，无需联网。",
    ]),
    h("Mermaid 图表", "h2"),
    bullet([
      "界面切换到「Mermaid」，书写源码即时渲染：flowchart / sequence / class / state / ER / mindmap / timeline / kanban / gantt / pie 等。",
      "选择器提供常见语法；图形可直接再编辑源码。",
    ]),
    h("AI 文生图", "h2"),
    bullet([
      "「AI 绘图」输入描述生成图片（文生图 / 图生图），插入到画布或页面。",
      "需在 AI 设置中配置并启用支持文生图的模型（OpenAI 兼容端点）；未配置时隐藏。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`绘图是编辑器的一种块 → ${link("编辑器")}；数据表格 → ${link("数据库与属性")}。`),
  ];
}

function columns(): Block[] {
  return [
    h("分栏", "h1"),
    callout("并排多列布局：把内容放进 2/3/4 列，自由拖拽调宽，适合对比、卡片、双栏排版。"),
    h("插入分栏", "h2"),
    bullet([
      "输入 `/分栏`，在子菜单选 2 / 3 / 4 栏，立即生成并排的栏，每栏都是独立编辑区。",
      "在栏内输入 / 继续插入任意块（段落、表格、绘图、公式…）。",
    ]),
    h("调整栏宽", "h2"),
    bullet([
      "拖动两栏之间的分隔线即可调整宽度（比例自适应，总宽不变、不溢出）。",
      "栏宽默认均分；可随时拖到需要的比例。",
    ]),
    h("适用场景", "h2"),
    bullet([
      "并排对比资料、双语对照、要点十卡片式排版、图片与文字并排。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`分栏组合块 → ${link("编辑器")}；更复杂的图表 → ${link("绘图")}。`),
  ];
}

function databaseProps(): Block[] {
  return [
    h("数据库与属性", "h1"),
    callout("属性给页面补充结构化信息，数据库用「透镜」的方式多视图展示同一批页面。"),
    h("属性", "h2"),
    bullet([
      "在页面属性面板添加属性：文本、数字、勾选、日期、多选、人员、关系、公式等。",
      "属性可做筛选、排序、字典映射；配合标签形成轻量索引。",
    ]),
    h("数据库视图", "h2"),
    bullet([
      "数据库 = 页面集合 + 视图：表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录。",
      "视图可保存；查询型视图按条件过滤；ref 关联跨库 pull 汇总。",
    ]),
    h("看板", "h2"),
    bullet([
      "看板按属性分组，支持跨列拖拽卡片（自动更新属性）。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`想用数据库做任务/素材库 → ${link("数据库与属性")} 已覆盖；回到 ${link("使用指南")} 看索引。`),
  ];
}

function pdfReader(): Block[] {
  return [
    h("PDF 阅读与批注", "h1"),
    callout("内置高性能 PDF 阅读器：连续滚动、目录、批注即块、AI 帮读。"),
    h("打开与阅读", "h2"),
    bullet([
      "把 PDF 作为附件拖入页面，或在文件视图打开；点击正文里的 PDF 附件直达阅读器。",
      "护眼多模式；支持连续滚动、目录树、跳页、适配页宽。",
    ]),
    h("批注", "h2"),
    bullet([
      "高亮 / 画笔 / 便签；自动提取文本层做精确划词，扫描件走离线 OCR。",
      "「摘录成块」把选中内容存成页面块，自动生成回链，可被搜索与反链追踪。",
    ]),
    h("AI 帮读", "h2"),
    bullet([
      "划选一段 → AI 总结 → 生成可回链的块；对整篇 PDF 提问按相关页检索回答。",
      "AI 一键生成目录（视觉大模型优先）；可离线系统朗读。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`批量读文献 → ${link("PDF 阅读与批注")} 已覆盖；回到 ${link("使用指南")} 看索引。`),
  ];
}

function ai(): Block[] {
  return [
    h("AI 助手", "h1"),
    callout("可选、默认关、本地优先的 AI。支持语义检索、内联起草、PDF 帮读。"),
    h("开启与配置", "h2"),
    bullet([
      "AI 需要在设置里配置模型端点与密钥（支持 OpenAI 兼容 / Ollama 本地）。",
      "不开也能用：全文检索 + 语义检索（未配置向量时可退回）。",
    ]),
    h("内联 AI 起草", "h2"),
    bullet([
      "在空行按空格（或 / AI）触发内联起草：流式写入、高亮待定块、一组快捷动作（完成/新建页/续写/扩写/重新生成/关闭）。",
      "写操作先落「预览高亮待定块」，点「完成」才落库——不丢确认。",
    ]),
    h("PDF / 视觉", "h2"),
    bullet([
      "PDF 划选帮读总结、整篇提问；页面截图视觉识别（OCR 离线兜底）。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`AI 能力分散在多处 → 详见 ${link("PDF 阅读与批注")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function dataSafety(): Block[] {
  return [
    h("数据安全与备份", "h1"),
    callout("本地优先。你的数据默认只在本机，不做云端同步；请定期备份。"),
    h("备份与导出", "h2"),
    bullet([
      "整库备份 / 导出（「存储」或命令面板）；支持按空间、按页面导出。",
      "可导出静态 wiki（双链/反链/索引），或 Markdown。",
    ]),
    h("版本 / 回收站", "h2"),
    bullet([
      "编辑自动留版本历史，可回滚；删除进回收站可恢复；彻底删除需清空回收站。",
      "清理/存储面板：清空回收站、清理孤立附件/旧版本/临时文件。",
    ]),
    h("加密 / 空间隔离", "h2"),
    bullet([
      "可选端到端加密（需记住密码）；多工作空间物理隔离，可单独备份/加密/搬移。",
    ]),
    h("同步", "h2"),
    bullet([
      "可自建 sync-server 做多设备同步（outbox + LWW + 附件增量）。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`多资料备份策略 → ${link("数据安全与备份")} 已覆盖；回到 ${link("使用指南")} 看索引。`),
  ];
}

function netdisk(): Block[] {
  return [
    h("文件夹 = 网盘", "h1"),
    callout("「文件夹」同时承载页面与文件：拖拽上传、在线预览、搜索、下载，还能管理文件版本，就像一个本地云盘。"),
    h("上传", "h2"),
    bullet([
      "进入文件夹后点「＋ 上传文件」选择文件，或直接把系统文件**拖进**文件夹窗口（Tauri 拖拽）。",
      "同一文件夹可批量上传；大文件走内容寻址，渐进式导入并显示进度。",
    ]),
    h("预览", "h2"),
    bullet([
      "图片 / 视频 / 音频在文件夹里直接内嵌预览；点击文件名即可打开。",
      "PDF 点击直达内置阅读器（可标注 / OCR / AI 帮读），不调起外部应用。",
      "其余类型可「预览」或「在文件夹中显示」。",
    ]),
    h("搜索与下载", "h2"),
    bullet([
      "文件夹顶部搜索框按文件名过滤；「下载」把文件另存到本地。",
      "「存储」面板可查看各空间/文件夹占用的空间，安全清理孤立附件。",
    ]),
    h("版本管理", "h2"),
    bullet([
      "同名文件自动合并为历史版本，点击操作列的 ↻ 查看/恢复任一版本。",
      "移除文件若不再被引用，其磁盘存储会被清除（有确认提示）。",
    ]),
    h("移动与引用", "h2"),
    bullet([
      "文件可移动到其他文件夹；页面里用「附件」引用文件，PDF 附件点击直达阅读器。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`文件与页面协同 → ${link("核心概念")}；存储与清理 → ${link("数据安全与备份")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function faq(): Block[] {
  return [
    h("常见问题 FAQ", "h1"),
    h("数据存在哪？", "h2"),
    para("默认存在本机的 SQLite + 附件目录。多工作空间则每空间独立目录，可搬移/单独备份/单独加密。"),
    h("会丢数据吗？", "h2"),
    para("改动即存，且有版本历史与回收站兜底；但请定期整库备份，以防本机故障。云同步需自建 sync-server。"),
    h("怎么升级/更新？", "h2"),
    para(`在命令面板 ${"Ctrl+K"} 输入「关于」，点「检查更新」即可（需联网）；应用支持自动更新，已签名的安装包会校验签名。`),
    h("能离线用吗？", "h2"),
    para("可以。核心功能完全离线；仅 AI / 同步 / 检查更新需联网（AI 可选本地模型）。"),
    h("页面里的 [[...]] 能点吗？", "h2"),
    para("能。正文里的 [[标题]] 已渲染为可点击链接，点击会跳到对应页面；也可在「未链接提及」里把正文标题一键转成双链。"),
    rule(),
    h("下一步", "h2"),
    para(`还有疑问 → 回到 ${link("使用指南")} 主索引，或从左侧侧边栏新建页面记录问题。`),
  ];
}

function shortcutsPage(): Block[] {
  const blocks: Block[] = [];
  blocks.push(h("常用快捷键", "h1"));
  blocks.push(callout("汇总所有全局与编辑器快捷键。完整帮助也可在应用内 Ctrl+/ 或 ? 打开面板。"));
  for (const g of shortcutGroups()) {
    blocks.push(h(g, "h2"));
    blocks.push(bullet(SHORTCUTS.filter((s) => s.group === g).map((s) => `${s.label}　${shortcutLabel(s)}`)));
  }
  blocks.push(rule());
  blocks.push(para(`编辑器与主要能力 → ${link("编辑器")}；回到 ${link("使用指南")} 看索引。`));
  return blocks;
}

// ---- index (main guide) -----------------------------------------------------
function indexBlocks(): Block[] {
  return [
    h("ShuyoNote 使用指南", "h1"),
    callout("本地优先 · 类 Notion 的笔记应用。这份指南本身就是一套可编辑的 Wiki：下面各篇互相用 [[双链]] 连接，可删可改；删了也能通过 /帮助 重建。"),
    h("开始使用", "h2"),
    bullet([
      `新建页面：Ctrl+N 或左侧栏 ＋；插入内容：输入 / 打开块菜单。`,
      `Ctrl+K 命令面板找到所有能力；Ctrl+/ 或 ? 打开快捷键面板。`,
      `正文里 [[标题]] 可点击跳转到对应页面。`,
    ]),
    h("指南目录", "h2"),
    bullet([
      link("快速开始"),
      link("核心概念"),
      link("编辑器"),
      link("数学公式"),
      link("绘图"),
      link("分栏"),
      link("数据库与属性"),
      link("文件夹 = 网盘"),
      link("PDF 阅读与批注"),
      link("AI 助手"),
      link("数据安全与备份"),
      link("常用快捷键"),
      link("常见问题 FAQ"),
    ]),
    rule(),
    h("更多", "h2"),
    callout("在命令面板 Ctrl+K 输入「关于」，可访问项目主页 / 文档 / 发布 / 问题（外链可在「关于」里关闭，不影响离线使用）。"),
  ];
}

// ---- page catalog -----------------------------------------------------------
export const GUIDE_PAGES: GuidePage[] = [
  { title: GUIDE_TITLE, icon: GUIDE_ICON, blocks: indexBlocks() },
  { title: "快速开始", icon: "🚀", blocks: quickStart() },
  { title: "核心概念", icon: "🧭", blocks: coreConcepts() },
  { title: "编辑器", icon: "✍️", blocks: editor() },
  { title: "数学公式", icon: "∑", blocks: equation(), parent: "编辑器" },
  { title: "绘图", icon: "✏️", blocks: drawing(), parent: "编辑器" },
  { title: "分栏", icon: "▥", blocks: columns(), parent: "编辑器" },
  { title: "数据库与属性", icon: "🗂️", blocks: databaseProps() },
  { title: "文件夹 = 网盘", icon: "📁", blocks: netdisk() },
  { title: "PDF 阅读与批注", icon: "📄", blocks: pdfReader() },
  { title: "AI 助手", icon: "✨", blocks: ai() },
  { title: "数据安全与备份", icon: "🔒", blocks: dataSafety() },
  { title: "常用快捷键", icon: "⌨️", blocks: shortcutsPage() },
  { title: "常见问题 FAQ", icon: "❓", blocks: faq() },
];

function pageJson(blocks: Block[]): string {
  return JSON.stringify({ root: { children: blocks, direction: "ltr", format: "", indent: 0, type: "root", version: 1 } as any });
}

function blockText(b: any): string {
  if (!b) return "";
  if (Array.isArray(b)) return b.map(blockText).join(" ");
  if (typeof b === "string") return b;
  if (b.type === "text") return b.text ?? "";
  if (Array.isArray(b.children)) return b.children.map(blockText).join("");
  return "";
}

function pageText(blocks: Block[]): string {
  return blocks.map(blockText).filter(Boolean).join("\n");
}

// Back-compat: the single main-index guide JSON/text (used by helpSite export).
export function guideJson(): string {
  return pageJson(GUIDE_PAGES[0].blocks);
}
export function guideText(): string {
  return pageText(GUIDE_PAGES[0].blocks);
}

/** Open the guide wiki (index + all topical pages), creating any that are missing
 *  and making every topical page a child of the index in the page tree.
 *  Idempotent: existing pages are kept; nothing is overwritten. */
export async function openGuide(opts: { open?: boolean } = {}): Promise<void> {
  const notes = useNotes.getState();
  const existingByTitle = new Map<string, string>();
  for (const p of notes.pages) existingByTitle.set(p.title || "", p.id);

  // 1) Ensure the index (main guide) exists first so children can nest under it.
  let indexId: string | null | undefined = existingByTitle.get(GUIDE_TITLE);
  if (!indexId) {
    indexId = await notes.createPage(null, {
      title: GUIDE_TITLE,
      content_json: pageJson(GUIDE_PAGES[0].blocks),
      content_text: pageText(GUIDE_PAGES[0].blocks),
    });
  }

  const ids: { title: string; id: string }[] = [];
  if (indexId) ids.push({ title: GUIDE_TITLE, id: indexId });

  // title → id, so a topical page can nest under another (parent: "…") whose id
  // may only be created later in this same run. We write each id as it lands.
  const idByTitle = new Map<string, string>(existingByTitle);
  if (indexId) idByTitle.set(GUIDE_TITLE, indexId);

  // 2) Ensure every topical page exists and sits under its designated parent
  //    (page.parent, or the main index when unset).
  for (const page of GUIDE_PAGES.slice(1)) {
    let id: string | null | undefined = existingByTitle.get(page.title);
    const parentTitle = page.parent ?? GUIDE_TITLE;
    const parentId = idByTitle.get(parentTitle) ?? indexId ?? null;
    if (!id) {
      id = await notes.createPage(parentId, {
        title: page.title,
        content_json: pageJson(page.blocks),
        content_text: pageText(page.blocks),
      });
    } else {
      // Page already exists: re-save canonical content so the backend rebuilds
      // block/backlink indexes (the relationship graph depends on them). Same
      // content — idempotent content-wise — but fills in any missing backlinks
      // that were never built when this page was first created programmatically.
      try {
        await api.savePage({
          id,
          content_json: pageJson(page.blocks),
          content_text: pageText(page.blocks),
        });
      } catch {
        // non-fatal: keep existing content
      }
    }
    if (id) {
      ids.push({ title: page.title, id });
      idByTitle.set(page.title, id);
      // If the page already exists but isn't a child of its parent, move it under.
      const meta = notes.pages.find((p) => p.id === id);
      if (meta && meta.parent_id !== parentId && parentId) {
        // Determine a sort order after any existing children of the parent.
        const order = notes.pages.filter((p) => p.parent_id === parentId).length;
        try {
          await notes.movePage(id, parentId, order);
        } catch {
          // non-fatal: page still exists, just not nested
        }
      }
    }
  }

  // The guide is a system set: keep cover/icon on canonical defaults.
  for (const page of GUIDE_PAGES) {
    const found = ids.find((x) => x.title === page.title);
    if (!found) continue;
    await api.setPageCover(found.id, GUIDE_COVER);
    await api.setPageIcon(found.id, page.icon);
  }

  const indexFinal = ids.find((x) => x.title === GUIDE_TITLE);
  if (opts.open !== false && indexFinal) await notes.openPage(indexFinal.id);
}
