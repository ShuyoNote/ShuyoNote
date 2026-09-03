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
// Parse inline `**bold**` into text nodes (bold = format 1) so the guide renders
// real bold instead of literal asterisks.
function rich(t: string): unknown[] {
  const out: unknown[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(text(t.slice(last, m.index)));
    out.push({ type: "text", text: m[1], version: 1, format: 1, detail: 0, mode: "normal", style: "" });
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(text(t.slice(last)));
  return out.length ? out : [text(t)];
}
function para(t: string): Block {
  return { type: "paragraph", version: 1, children: rich(t) as any, direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function h(t: string, tag: "h1" | "h2" | "h3"): Block {
  return { type: "heading", tag, version: 1, children: rich(t) as any, direction: "ltr", format: "", indent: 0, style: "", mode: "normal", textFormat: 0, textStyle: "" } as any;
}
function callout(t: string): Block {
  return { type: "callout", version: 1, children: [para(t)], direction: "ltr", format: "", indent: 0, style: "" } as any;
}
function bullet(items: string[]): Block {
  return {
    type: "list", tag: "ul", listType: "bullet", start: 1, version: 1, direction: "ltr", format: "", indent: 0, style: "",
    children: items.map((it) => ({ type: "listitem", version: 1, value: 1, direction: "ltr", format: "", indent: 0, style: "", children: rich(it) })),
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
    callout("本地优先 · 类 Notion：笔记保存在本机（SQLite + 附件目录），离线可用、改动即存；块编辑器 + 数据库（多视图）+ 双链，数据留在本地，可自建端到端加密同步。"),
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
      "表格、分栏（/分栏）、绘图（/绘图：Excalidraw + mermaid）、图片、网址书签。",
      "高级块各有专题：数学公式 / 绘图 / 分栏 / 图片与附件 / 表格块 / 代码块 / 待办列表。",
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

function imageAttach(): Block[] {
  return [
    h("图片与附件", "h1"),
    callout("在页面里插入图片 / 文件 / 附件；图片可预览、拖动大小，文件走内容寻址存储。"),
    h("插入图片", "h2"),
    bullet([
      "输入 / 图片，或粘贴截图 / 拖入图片文件——自动上传并插入为块。",
      "点击图片可预览大图；拖动边缘调整大小；右键复制/替换/删除。",
    ]),
    h("插入附件", "h2"),
    bullet([
      "输入 / 文件 或点附件面板，挂载任意本地文件。",
      "附件以内容寻址存储（相同内容只存一份）；点击附件下载或用预览打开。",
    ]),
    h("封面 / 题头图", "h2"),
    bullet([
      "页面顶部可加题头图（免版权风景或自定义图片），在封面上拖拽定位、调整高度。",
    ]),
    h("注意事项", "h2"),
    bullet([
      "大文件异步上传并显示进度；附件不占页面内容，可随时在「附件」面板统一管理。",
      `更多存储/清理见 ${link("数据安全与备份")}；文件夹 = 网盘见 ${link("文件夹 = 网盘")}。`,
    ]),
    rule(),
    para(`回到 ${link("编辑器")}；双链 → ${link("链接与双链")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function tableBlock(): Block[] {
  return [
    h("表格块", "h1"),
    callout("写作用的内嵌表格：行列可增删、单元格可填文字，适合在页面里放小表格。"),
    h("插入", "h2"),
    bullet([
      "输入 / 表格（或 /table），选择行列数生成。",
      "点表格左上角图标加行/列，右键或头部操作删行/列。",
    ]),
    h("编辑", "h2"),
    bullet([
      "点击单元格输入内容，Tab 跳到下一格；单元格支持粗体/斜体等行内格式。",
      "可设置是否显示表头；列宽可拖。",
    ]),
    h("与数据库表格的区别", "h2"),
    bullet([
      "表格块是**页面内静态表格**，不关联页面/属性。",
      `要「一行一个页面、一列一个属性」的数据表，用 ${link("数据库与属性")}。`,
    ]),
    rule(),
    para(`回到 ${link("编辑器")}；数据库 → ${link("数据库与属性")}；回到 ${link("使用指南")}。`),
  ];
}

function codeBlock(): Block[] {
  return [
    h("代码块", "h1"),
    callout("展示/编辑代码的块，带语法高亮与语言选择，适合贴代码。"),
    h("插入", "h2"),
    bullet([
      "输入 / 代码（或 /code），选择语言（js/ts/python/java/sql 等）或留自动。",
    ]),
    h("使用", "h2"),
    bullet([
      "代码块内 Tab 不缩进页面，而是缩进代码；语言标签可切换。",
      "支持复制代码；部分语言有语法高亮。",
    ]),
    h("提示", "h2"),
    bullet([
      "若只是「行内代码」，选中文字用工具条的行内代码（`）即可，不必用块。",
      "代码块是文本块；如需真执行需外部环境，ShuyoNote 不运行代码。",
    ]),
    rule(),
    para(`回到 ${link("编辑器")}；行内格式见编辑器；回到 ${link("使用指南")}。`),
  ];
}

function todoBlock(): Block[] {
  return [
    h("待办列表", "h1"),
    callout("带复选框的列表项——勾选完成状态，适合清单/任务/检查表。"),
    h("插入", "h2"),
    bullet([
      "输入 / 待办（或 /todo）；或把现有列表项转为待办。",
      "每项前有复选框，点击勾选/取消。",
    ]),
    h("使用", "h2"),
    bullet([
      "勾选后的待办可置灰/划掉（主题而定），形成「已完成」视觉。",
      "可改为无符号清单、无序列表、编号列表。",
      "适合项目清单、购物清单、检查清单、每日待办。",
    ]),
    h("小提示", "h2"),
    bullet([
      "需要「按状态推进 + 多视图」时，用数据库看板更合适；待办列表适合轻量勾选。",
      `任务/项目 → ${link("数据库与属性")} / ${link("看板与标签")}。`,
    ]),
    rule(),
    para(`回到 ${link("编辑器")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function equation(): Block[] {
  return [
    h("数学公式", "h1"),
    callout("块级 / 行内公式，用 LaTeX 书写并渲染为 KaTeX；配 Notion 风格符号面板，还能把图片 / 手写公式自动转成 LaTeX。"),
    h("插入方式", "h2"),
    bullet([
      "块级：输入 `/公式`，或独立成行写 `$$…$$`（`$$` 之间的内容渲染为独立的公式块）。",
      "行内：正文里写 `$…$`（如 `$x^2$`），内嵌在一行文字中间；`$` 包裹即可。",
    ]),
    h("公式编辑器", "h2"),
    bullet([
      "点击公式块即可再次编辑：Notion 风格符号面板分 六类（希腊字母 / 运算符 / 关系式 / 式子 / 箭头 / 化学）。",
      "左侧实时预览；`Ctrl+Enter` 提交；弹窗紧贴公式块下方，符号面板向上展开。",
    ]),
    h("识别图片 / 手写公式", "h2"),
    bullet([
      "`🖼`（编辑器左下）：上传/拖入/粘贴含公式的图片 → 自动转 LaTeX。",
      "`✎`（编辑器左下）：打开手写板，笔写公式 → 自动转 LaTeX。",
      "识别结果**回填到输入框**、可改后再提交（保留人工确认）；需在 AI 设置配置支持图像的模型。",
    ]),
    h("常用写法", "h2"),
    bullet([
      "希腊字母：`\\alpha \\beta \\gamma \\delta \\Delta` → α β γ δ Δ。",
      "上下标：`x^{2}`、`x_{i}`、`a_i^2`。",
      "分数/根式：`\\frac{a}{b}`、`\\sqrt{x}`、`\\sqrt[3]{x}`。",
      "求和/积分/极限：`\\sum_{i=1}^{n}`、`\\int_{a}^{b}`、`\\lim_{x\\to 0}`。",
      "矩阵/数组：`\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}`。",
      "多行对齐：`\\begin{aligned} x &= y \\\\ y &= z \\end{aligned}`。",
      "区间/集合：`[0,1]`、`\\{x \\mid x>0\\}`、`\\cup`、`\\cap`。",
      "箭头/关系：`\\to` `\\rightarrow` `\\Rightarrow` `\\ge` `\\le` `\\ne`。",
      "文本：`\\text{单位：元}`；化学：`\\mathrm{H_2O}`、`\\mathrm{CO_2}`。",
    ]),
    h("编写技巧", "h2"),
    bullet([
      "用 `\\ `(反斜杠+空格) 强制留一个空格；标点多用 `\\,` 微调间距。",
      "括号不匹配常报错——检查 `{}`/`()`/`\\begin{}`-`\\end{}` 成对。",
      "复杂公式先拆成小块测试，再加嵌套；KaTeX 支持常用全部数学宏，遇未知宏会显示红色。",
    ]),
    h("注意事项", "h2"),
    bullet([
      "纯文本里的 `$` 若想原样显示，请转义 `\\$`。",
      "只有行内需显示的简单式用 `$…$`，独立/多行公式用 `$$…$$`。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`公式是编辑器的一种块 → ${link("编辑器")}；想了解整体理念 → ${link("核心概念")}。`),
  ];
}

function drawing(): Block[] {
  return [
    h("绘图", "h1"),
    callout("手绘白板（Excalidraw）+ 思维导图/流程图（Mermaid），都在「绘图」块里，离线可用。"),
    h("插入画布", "h2"),
    bullet([
      "输入 `/绘图` 插入绘图块，点击进入编辑器；支持缩放 / 平移 / 全屏。",
      "绘图块文档自动存入页面；图片可导出；无需联网。",
    ]),
    h("手绘（Excalidraw）", "h2"),
    bullet([
      "工具：选择 / 画笔 / 线条 / 箭头 / 矩形 / 椭圆 / 菱形 / 文字 / 方框文本 / 连线。",
      "画布上拖拽缩放、框选、复制；形状可填充颜色、调整层级。",
      "适合草图、白板、流程图草稿、结构示意。",
    ]),
    h("Mermaid 图表", "h2"),
    bullet([
      "界面切换到「Mermaid」，写源码即时渲染。",
      "支持：flowchart（流程图）/ sequence（时序图）/ class（类图）/ state（状态图）/ ER（实体关系）/ mindmap（思维导图）/ timeline（时间线）/ kanban（看板）/ gantt（甘特图）/ pie（饼图）。",
      "左侧有语法选择器提供示例；点图形可回到源码再编辑。",
    ]),
    h("两种模式切换", "h2"),
    bullet([
      "同一绘图块可在「手绘 / Mermaid」之间切换；Mermaid 适合结构化图表，手绘适合自由草图。",
    ]),
    h("导出", "h2"),
    bullet([
      "可导出为图片（PNG / SVG）；也可复制到剪贴板。",
      "绘图块在页面中作为图片展示，导出/打印时一并输出。",
    ]),
    h("适用场景", "h2"),
    bullet([
      "产品/技术图：架构图、流程图、时序图、ER 图。",
      "学习笔记：思维导图、知识梳理、时间线。",
      "头脑风暴：白板自由画、连线、标注。",
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
      "在栏内输入 `/` 插入任意块（段落、列表、表格、绘图、公式…）。",
    ]),
    h("调整栏宽", "h2"),
    bullet([
      "拖动两栏之间的分隔线调整宽度（比例自适应，总宽不变、不溢出）。",
      "栏宽默认均分，可随时拖到需要的比例。",
    ]),
    h("栏内移动与删除", "h2"),
    bullet([
      "块仍可拖拽：把某块拖入/拖出栏，或调整栏的顺序。",
      "要删除某栏，可把栏内块移出后整栏删除（或清空后删除分栏块）。",
    ]),
    h("适用场景", "h2"),
    bullet([
      "并排对比（新旧/优缺点/数据对照）。",
      "双栏排版：左侧目录/参数、右侧正文。",
      "卡片式排布：多张要点并排，视觉更层次。",
      "图片 + 文字并排；双语/术语对照。",
    ]),
    h("小提示", "h2"),
    bullet([
      "浏览器小窗口下，分栏会自适应换行/堆叠，保证可读。",
      "需要「数据表格式」多列管理，用数据库；分栏是**页面排版**用的。",
    ]),
    rule(),
    h("下一步", "h2"),
    para(`分栏组合块 → ${link("编辑器")}；更复杂的图表 → ${link("绘图")}。`),
  ];
}

function dbRef(): Block[] {
  return [
    h("ref 关联", "h1"),
    callout("把数据库里的页面/行「互相连起来」——像数据库的外键，一处改、多处联动。"),
    h("用途", "h2"),
    bullet([
      "一个属性可以引用**别的页面或数据库行**作为值，建立页面之间的关系。",
      "在引用目标库的字段（跨库 pull / rollup 汇总），联动显示与更新。",
      "点关联值跳转到目标页面，同一关系下可聚合（如某项目下的全部任务）。",
    ]),
    h("怎么加", "h2"),
    bullet([
      "在数据库添加属性，属性类型选「关系 / ref（关联）」。",
      "设置关联的目标库或页面集合，单元格里选择要关联的具体页面。",
      "关联后的属性值可点击，跳转到目标页面。",
    ]),
    h("跨库 pull（汇总）", "h2"),
    bullet([
      "从关联目标的某字段**拉取值到本库显示**（如任务页自动带出项目负责人/截止日期）。",
      "改目标库里那行的字段，本库自动**同步更新**。",
    ]),
    h("示例", "h2"),
    bullet([
      "任务库「所属项目」→ 项目库；「负责人」→ 成员库——一个项目下聚合所有任务。",
      "文章库「作者」→ 作者库；再 pull 出作者的 简介/头像。",
      "记账库「分类」→ 分类库；按分类聚合月度支出。",
    ]),
    h("注意事项", "h2"),
    bullet([
      "关联目标需**存在**；删除目标后引用值可能置空或失效。",
      "跨库 pull 增加查询成本，量大时注意性能。",
      "适合「一个数据多个数据库共用」的场景，避免重复录入。",
    ]),
    rule(),
    para(`属性与数据库 → ${link("数据库与属性")}；公式列 → ${link("公式列")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function dbFormula(): Block[] {
  return [
    h("公式列", "h1"),
    callout("用其它属性 + 常量**自动算出**一个值——不用手敲，源数据一变结果就更新。"),
    h("用途", "h2"),
    bullet([
      "把多个属性/常量组合成新的计算结果，作为一列显示。",
      "简化重复计算（进度、天数、汇总、逾期判断等）。",
    ]),
    h("怎么加", "h2"),
    bullet([
      "在数据库添加属性，属性类型选「公式 / formula」。",
      "在公式表达式里引用其它属性，写计算规则。",
      "引用的源属性变化时，公式列**自动重算**。",
    ]),
    h("常见计算", "h2"),
    bullet([
      "数学：天数 = 结束日期 − 开始日期；进度% = 已完成 ÷ 总数 × 100。",
      "文本：拼接 = 城市 + 年份（如「上海 2024」）。",
      "条件/判断：如果 截止日期 < 今天 → 「已逾期」，否则「进行中」。",
      "汇总：统计某列的和 / 平均值（配合分组）。",
    ]),
    h("示例", "h2"),
    bullet([
      "任务表：剩余天数 = 截止日期 − 今天；状态提示 = if(逾期,「已逾期」,「正常」)。",
      "内容库：字数统计、阅读量、评分均值。",
      "记账：月度合计 = 分类各笔之和。",
    ]),
    h("注意事项", "h2"),
    bullet([
      "公式依赖引用的源属性；源属性为空时结果可能为空或报错，注意判空。",
      "复杂公式（深层嵌套/跨表）请拆分或先用简单条件验证。",
    ]),
    rule(),
    para(`属性与数据库 → ${link("数据库与属性")}；ref 关联 → ${link("ref 关联")}；回到 ${link("使用指南")} 看索引。`),
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
      `高级属性：${link("ref 关联")}（跨库引用/pull 汇总）与 ${link("公式列")}（自动计算）。`,
    ]),
    h("数据库视图", "h2"),
    bullet([
      "数据库 = 页面集合 + 视图：表格 / 画廊 / 看板 / 列表 / 日历 / 时间轴 / 目录 / 甘特图。",
      "视图可保存；查询型视图按条件过滤；ref 关联跨库 pull 汇总。",
      `各视图：${link("表格视图")} · ${link("画廊视图")} · ${link("看板与标签")} · ${link("列表视图")} · ${link("日历视图")} · ${link("时间轴视图")} · ${link("数据库目录")} · ${link("甘特图")}。`,
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

function databaseDirectory(): Block[] {
  return [
    h("数据库目录", "h1"),
    callout("把数据库里的页面按「父子层级」组成树状目录，点击标题直接跳到对应页面。"),
    h("是什么", "h2"),
    para("目录视图把当前数据库命中（含标题筛选后）的页面，按它们的**父子关系**搭成一棵可缩放的树；每一级缩进代表一层父子关系，点击节点跳到对应页面。"),
    h("能做什么", "h2"),
    bullet([
      "以层级视角浏览一组页面：章节 → 子章节 → 页面，像一本目录/书签。",
      "快速跳转：随便点某个标题就打开那个页面。",
      "层级缩进直观看出谁是谁的下级。",
      "无子层级时平铺成一级列表，作为普通索引。",
    ]),
    h("怎么用", "h2"),
    bullet([
      "进入数据库 → 顶部视图切换选「目录」→ 自动生成目录树。",
      "点击节点标题打开对应页面；点回数据库目录继续浏览。",
      "配合标题筛选（空格=与、逗号=或）缩小目录范围。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "一套体系文档 / 知识库：手册、教程、帮助文档的章节级目录。",
      "项目资料：按模块/子模块组织的页面集合。",
      "任何「有父子层级的内容」——用目录看到全貌。",
    ]),
    h("小提示", "h2"),
    bullet([
      "目录依赖页面之间的父子关系（某页作为另一页的子页面）。",
      "若所有页面平级（无子页），目录会退化为一级列表——此时用列表/表格视图更合适。",
    ]),
    rule(),
    para(`目录是数据库的一种视图 → ${link("数据库与属性")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function dbTable(): Block[] {
  return [
    h("表格视图", "h1"),
    callout("最基础的数据库视图：一行一个页面，一列一个属性，像电子表格，但每一行背后是一个真实页面。"),
    h("是什么", "h2"),
    para("表格视图用行 = 页面、列 = 属性的网格展示数据。它既是数据表，也是补录/修改属性的前台：改格子里的值就写回对应页面。"),
    h("能做什么", "h2"),
    bullet([
      "直接编辑属性值：点单元格即可改文本、数字、日期、勾选、多选、关系、公式等。",
      "「＋ 列」加属性列；列头可排序、按列筛选。",
      "标题列点击打开对应页面；标题筛选框精确过滤。",
      "切其它视图（画廊/看板/日历/甘特图…）看同一批页面的不同角度。",
    ]),
    h("列的编辑", "h2"),
    bullet([
      "点列头右侧可编辑列名、类型、选项；拖动列头调整列顺序。",
      "支持文本、数字、勾选、日期、多选、人员、关系(ref)、公式、进度等类型。",
      "属性类型决定单元格的输入控件（如日期会弹出日期选择）。",
    ]),
    h("筛选与排序", "h2"),
    bullet([
      "顶部「按标题筛选」支持**空格=与、逗号=或**（如 `项目 计划` 为与，`项目,计划` 为或）。",
      "列头点击可按该列升/降序排列。",
      "可保存视图，随时切回常用表格布局。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "项目/任务管理：一行一个任务，列管状态、优先级、负责人、截止日期。",
      "内容/素材库：方便批量维护属性。",
      "需要「补录 + 统计 + 多视图切换」的数据管理。",
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；其它视图见 ${link("画廊视图")}、${link("看板与标签")} 等；回到 ${link("使用指南")}。`),
  ];
}

function dbGallery(): Block[] {
  return [
    h("画廊视图", "h1"),
    callout("把每个页面当成一张卡片，适合看图找内容（封图/图片/素材）。"),
    h("是什么", "h2"),
    para("画廊以卡片形式展示数据库里的页面——有题头图/封面的页面更像照片墙，点卡片打开对应页面，浏览感强。"),
    h("能做什么", "h2"),
    bullet([
      "卡片网格直观浏览：封面/题头图大的内容一眼看到。",
      "点击卡片打开对应页面；卡片可带标题、摘要、关键属性。",
      "适合「以图为中心的浏览」——素材、作品、封面、截图库。",
    ]),
    h("怎么用", "h2"),
    bullet([
      "切换「画廊」视图即可。",
      "给页面加题头图/封面后，画廊更醒目。",
      "用标题筛选/排序缩小或重排卡片。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "图片素材库、设计作品集、商品图册。",
      "需要「快速扫一眼找到目标」的内容集合。",
      "以封面为主的浏览型数据库。",
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；列表视图 → ${link("列表视图")}；回到 ${link("使用指南")}。`),
  ];
}

function dbList(): Block[] {
  return [
    h("列表视图", "h1"),
    callout("紧凑的列表：每行一个页面，左侧标题、右侧预览属性，可展开看全部。"),
    h("是什么", "h2"),
    para("列表用「一行一个页面」的紧凑形式罗列条目，信息密度高、扫读快；行右侧预览前几个属性，点 ▸ 可展开该行全部属性。"),
    h("能做什么", "h2"),
    bullet([
      "快速浏览/扫读大批页面：只看标题 + 少量关键属性。",
      "行内「▸/▾」展开/收起该行全部属性（手风琴，按行独立）。",
      "点标题打开对应页面；标题筛选/排序快速定位。",
    ]),
    h("怎么用", "h2"),
    bullet([
      "切换「列表」视图。",
      "默认显示每行前 3 个有值的属性；点 ▸ 展开全部，点 ▾ 收起。",
      "标题筛选（空格=与、逗号=或）缩小范围。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "待办/清单式管理：快速勾选、过一遍。",
      "条目很多、需要一屏看全的信息列表。",
      "只想确认「有哪些页面、都叫什么」的场合。",
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；表格视图 → ${link("表格视图")}；回到 ${link("使用指南")}。`),
  ];
}

function dbCalendar(): Block[] {
  return [
    h("日历视图", "h1"),
    callout("按日期把页面排进月历，直观看到某天的安排/内容。"),
    h("是什么", "h2"),
    para("日历视图把数据库页面按某个**日期列**映射到月历格子上：某页的日期落在哪天，就显示在那天的格子里，按月浏览一目了然。"),
    h("先决条件", "h2"),
    bullet([
      "数据库需有一个 **date（日期）** 属性列作为日历的时间依据。",
      "页面该日期有值，才会出现在对应日期格子。",
    ]),
    h("怎么用", "h2"),
    bullet([
      "切换「日历」视图，显示当前月；用左右箭头切换月份。",
      "点击某天/某页查看或跳转；日期变化自动移动位置。",
      "配合日期列筛选，聚焦某段时间。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "日程/排期：会议、发布、到期日按日历看。",
      "每月回顾：生日、纪念、月度内容分布。",
      "任何「按日期安排、按月查看」的内容。",
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；时间轴视图 → ${link("时间轴视图")}；回到 ${link("使用指南")}。`),
  ];
}

function dbTimeline(): Block[] {
  return [
    h("时间轴视图", "h1"),
    callout("按时间横轴线性排列条目，看清先后顺序与跨度。"),
    h("是什么", "h2"),
    para("时间轴把页面按**日期属性**沿一条连续时间横轴排布，像大事记/里程碑：能看到先后顺序、时间跨度、事件密集程度。"),
    h("先决条件", "h2"),
    bullet([
      "数据库需有 **date** 日期列作为时间排序依据。",
      "页面日期有值才会出现在时间轴上；无日期可手动补充。",
    ]),
    h("怎么用", "h2"),
    bullet([
      "切换「时间轴」视图，条目沿横轴排布。",
      "点击条目跳到对应页面。",
      "与日历（格子按月）不同，时间轴是连续线性，弱化「月」、强调整体先后。",
    ]),
    h("适合什么", "h2"),
    bullet([
      "项目里程碑 / 版本记录：看先后与跨度。",
      "大事记、发展史：按时间串起各节点。",
      "需要「从整体看时间脉络」的内容。",
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；日历视图 → ${link("日历视图")}；回到 ${link("使用指南")}。`),
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
      "可自建 shuyonote-sync-server 做多设备同步（outbox + LWW + 附件增量）。",
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
    para("改动即存，且有版本历史与回收站兜底；但请定期整库备份，以防本机故障。云同步需自建 shuyonote-sync-server。"),
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

// ---- 新增主题页：甘特图 / 看板与标签 / 搜索与语义检索 / 封面与主题 ----
function gantt(): Block[] {
  return [
    h("甘特图", "h1"),
    callout("用日期列把数据库一键变成专业甘特图——计划 / 实际两组、可编辑日期、列宽可拖。"),
    h("是什么", "h2"),
    para("甘特图视图把数据库行按**开始/结束日期**画成横向时间条，像项目排期表：一眼看到每项任务的起止、时长、重叠与整体进度。"),
    h("从数据库生成", "h2"),
    bullet([
      `建一个含 date 列的数据库（可用「项目计划·甘特图」模板）。`,
      `切「甘特图」视图：开始/结束日期生成时间条；若建 4 个 date 列（计划 + 实际）则显示两组对比。`,
    ]),
    h("时间条与跟进", "h2"),
    bullet([
      `每条任务一条横条，横轴为日期；多条叠加看出排期是否冲突。`,
      `计划/实际两组并列，直观对比「计划 vs 实际」的偏差。`,
      `网格填色 + 汇总，一眼看项目进度。`,
    ]),
    h("编辑", "h2"),
    bullet([
      `开始/结束日期可直接键入或点 📅 选择，改后格子实时刷新。`,
      `「任务」表头右缘拖拽调列宽；最小宽度防止日期溢出。`,
      `点任务标题跳转到对应页面补充细节。`,
    ]),
    h("适合什么", "h2"),
    bullet([
      `项目/研发排期：里程碑、任务起止、依赖时间。`,
      `多任务并行时的排期冲突检查与进度盘点。`,
    ]),
    rule(),
    para(`想用数据库管理任务 → ${link("数据库与属性")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function board(): Block[] {
  return [
    h("看板与标签", "h1"),
    callout("数据库看板 / 标签看板，卡片跨列拖、列拖换序——像真正的项目工具。"),
    h("是什么", "h2"),
    para("看板把数据库页面按某个属性分成若干「列」，每格一个卡片，靠**拖拽卡片跨列**来改属性值，非常顺手的流程管理方式。"),
    h("数据库看板", "h2"),
    bullet([
      `任选一个 select 列分组，切「看板」视图。`,
      `卡片拖到另一列 = 改分组值；列(header)拖拽换序；「未设置」列固定最左。`,
      `适合任务流：未开始 → 进行中 → 已完成，拖卡片就能推进状态。`,
    ]),
    h("标签体系", "h2"),
    bullet([
      `页面可加标签（属性区 / 标签管理器），未完成/进行中/已完成 默认三色。`,
      `左侧「看板」按标签分列，卡片拖拽跨列切换标签；标签颜色可自定义。`,
    ]),
    h("怎么用", "h2"),
    bullet([
      `切换「看板」视图，按状态/优先级/负责人分组。`,
      `拖动卡片换列；空白处点卡片打开页面。`,
      `与表格/甘特图切换看同一数据的流程与时间两种视角。`,
    ]),
    h("适合什么", "h2"),
    bullet([
      `任务/项目流程管理、CRM 客户阶段、内容审核流。`,
      `任何「按某个状态推进、靠拖动管理」的流程。`,
    ]),
    rule(),
    para(`数据库 → ${link("数据库与属性")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function search(): Block[] {
  return [
    h("搜索与语义检索", "h1"),
    callout("不只匹配关键词——嵌入向量语义检索，找到「想表达的意思」。"),
    h("全文搜索", "h2"),
    bullet([
      `Ctrl+Shift+F 或顶部搜索框：多关键词 AND，全空间默认，跨空间可跳转，prop: 前缀按属性搜。`,
    ]),
    h("语义检索", "h2"),
    bullet([
      `在 AI 设置里配置模型端点后，语义检索按语义相似度排序，全空间 / 跨空间找相关内容。`,
      `与 AI 助手联动：提问 → 检索相关笔记上下文。`,
    ]),
    rule(),
    para(`AI 配置 → ${link("AI 助手")}；回到 ${link("使用指南")} 看索引。`),
  ];
}

function coverTheme(): Block[] {
  return [
    h("封面与主题外观", "h1"),
    callout("让每篇笔记有自己的气质——封面题头图 + 亮/暗主题、自绘标题栏、目录。"),
    h("封面题头图", "h2"),
    bullet([
      `页面顶部 →「添加题头图」：渐变 / 免版权风景照片（峡湾/雪峰/海岸/绿雾/瀑布/树木…）。`,
      `在封面上上下拖动可定位背景位置；拖右下手柄调高度。`,
    ]),
    h("主题外观", "h2"),
    bullet([
      `设置 → 外观：亮 / 暗主题（跟随系统或手动）；自绘标题栏（可切回系统栏）。`,
      `右侧目录( TOC )按标题生成，侧栏可折叠。`,
    ]),
    rule(),
    para(`回到 ${link("使用指南")} 看索引。`),
  ];
}

// ---- index (main guide) -----------------------------------------------------
function indexBlocks(): Block[] {
  return [
    h("ShuyoNote 使用指南", "h1"),
    callout(`本地优先 · 类 Notion 的块笔记应用：块编辑器 + 数据库（表格 / 看板 / 画廊 / 列表 / 日历 / 时间轴 / 项目管理）+ 双链、块引用、块嵌入，数据留在本机、离线可用，可自建端到端加密同步。这份指南本身就是一套可编辑的 Wiki：下面各篇互相用 [[双链]] 连接，可删可改；删了也能通过 /帮助 重建。`),
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
      link("甘特图"),
      link("看板与标签"),
      link("搜索与语义检索"),
      link("封面与主题外观"),
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
  { title: "图片与附件", icon: "🖼️", blocks: imageAttach(), parent: "编辑器" },
  { title: "表格块", icon: "🔲", blocks: tableBlock(), parent: "编辑器" },
  { title: "代码块", icon: "💻", blocks: codeBlock(), parent: "编辑器" },
  { title: "待办列表", icon: "✅", blocks: todoBlock(), parent: "编辑器" },
  { title: "数据库与属性", icon: "🗂️", blocks: databaseProps() },
  { title: "数据库目录", icon: "🌲", blocks: databaseDirectory(), parent: "数据库与属性" },
  { title: "表格视图", icon: "📋", blocks: dbTable(), parent: "数据库与属性" },
  { title: "画廊视图", icon: "🖼️", blocks: dbGallery(), parent: "数据库与属性" },
  { title: "列表视图", icon: "📄", blocks: dbList(), parent: "数据库与属性" },
  { title: "日历视图", icon: "📅", blocks: dbCalendar(), parent: "数据库与属性" },
  { title: "时间轴视图", icon: "📈", blocks: dbTimeline(), parent: "数据库与属性" },
  { title: "甘特图", icon: "📊", blocks: gantt(), parent: "数据库与属性" },
  { title: "看板与标签", icon: "📋", blocks: board(), parent: "数据库与属性" },
  { title: "ref 关联", icon: "🔗", blocks: dbRef(), parent: "数据库与属性" },
  { title: "公式列", icon: "🧮", blocks: dbFormula(), parent: "数据库与属性" },
  { title: "搜索与语义检索", icon: "🔍", blocks: search() },
  { title: "封面与主题外观", icon: "🎨", blocks: coverTheme() },
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
