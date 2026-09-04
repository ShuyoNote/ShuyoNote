// Template-center data. Built-in templates carry real Lexical `content_json`
// that seeds a new page on "create from template". A later step (M9.2) persists
// user templates ("我的模板") to the DB and adds save-as-template / import.

export interface TemplateItem {
  id: string;
  name: string;
  category: string;
  icon: string;
  cover: string; // CSS gradient (placeholder cover)
  content_json: string; // Lexical editor state used to seed a new page
  content_text: string; // plain-text mirror (for FTS indexing)
  kind?: "page" | "database"; // database templates preset columns via database_json
  database_json?: string; // JSON string: { columns: [{name,type,options?}] }
}

export const TEMPLATE_CATEGORIES = ["全部", "个人", "工作", "教育", "健康", "我的模板"] as const;

// M20.1 — substitute template variables (`{{date}}` / `{{title}}` / `{{selected}}`)
// with the create-time context (today, page title, currently selected text).
export function substituteTemplateVars(
  str: string,
  ctx: { date?: string; title?: string; selected?: string; owner?: string },
): string {
  return String(str ?? "")
    .replace(/\{\{date\}\}/g, ctx.date ?? "")
    .replace(/\{\{title\}\}/g, ctx.title ?? "")
    .replace(/\{\{selected\}\}/g, ctx.selected ?? "")
    .replace(/\{\{owner\}\}/g, ctx.owner ?? "");
}

// ---- Lexical block builders (standard nodes only — avoid custom nodes so
// template content is always valid) ----
type Block = Record<string, any>;
const text = (s: string): Block => ({
  type: "text", version: 1, text: s, format: 0, detail: 0, mode: "normal", style: "",
});
const para = (...parts: string[]): Block => ({
  type: "paragraph", version: 1, children: parts.map(text), direction: "ltr", format: "", indent: 0, style: "",
});
const heading = (tag: string, s: string): Block => ({
  type: "heading", tag, version: 1, children: [text(s)], direction: "ltr", format: "", indent: 0, style: "",
});
const bullet = (items: string[]): Block => ({
  type: "list", tag: "ul", version: 1, listType: "bullet", start: 1,
  children: items.map((it) => ({
    type: "listitem", version: 1, value: 1, children: [text(it)], direction: "ltr", format: "", indent: 0, style: "",
  })),
  direction: "ltr", format: "", indent: 0, style: "",
});
const quote = (s: string): Block => ({
  type: "quote", version: 1, children: [text(s)], direction: "ltr", format: "", indent: 0, style: "",
});
const rule = (): Block => ({ type: "horizontalrule", version: 1, direction: "ltr", format: "", indent: 0, style: "" });

function rootJson(blocks: Block[]): string {
  return JSON.stringify({
    root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: blocks },
  });
}
function textOf(blocks: Block[]): string {
  const walk = (n: any): string => {
    if (!n) return "";
    if (Array.isArray(n)) return n.map(walk).join(" ");
    if (typeof n === "string") return n;
    if (typeof n === "object") {
      if (n.type === "text") return n.text ?? "";
      if (n.type === "linebreak") return "\n";
      if (Array.isArray(n.children)) return n.children.map(walk).join(" ");
      return "";
    }
    return "";
  };
  return blocks.map(walk).join("\n");
}

function tmpl(
  id: string, name: string, category: string, icon: string, cover: string, blocks: Block[],
): TemplateItem {
  return { id, name, category, icon, cover, content_json: rootJson(blocks), content_text: textOf(blocks) };
}

// A database template: presets the database page's columns (attr_defs + database_columns).
function dbtmpl(
  id: string, name: string, category: string, icon: string, cover: string,
  columns: { name: string; type: string; options?: string[] }[],
): TemplateItem {
  return {
    id, name, category, icon, cover,
    content_json: rootJson([]), content_text: "",
    kind: "database",
    database_json: JSON.stringify({ columns }),
  };
}

export const TEMPLATES: TemplateItem[] = [
  tmpl("library", "我的个人图书馆", "个人", "📚", `url("covers/mist.jpg")`, [
    heading("h1", "我的个人图书馆"),
    quote("一本书改变一个人；一个图书馆，改变一个人的人生轨迹。"),
    rule(),
    heading("h2", "想读 · To Read"),
    bullet(["《被讨厌的勇气》—— 岸见一郎", "《原则》—— 桥水 · 达利欧", "《置身事内》—— 兰小欢"]),
    rule(),
    heading("h2", "在读 · In Progress"),
    bullet(["《克拉拉与太阳》—— 石黑一雄，进度 40%", "《人类简史》—— 赫拉利，进度 20%"]),
    rule(),
    heading("h2", "已读 · Finished"),
    para("读完一本，在建一个页面写短评/摘录/评分，并归到「已读」。"),
    rule(),
    heading("h2", "本季度目标"),
    bullet(["读完 3 本", "精读 1 本并输出笔记", "做一次主题阅读（AI / 历史）"]),
  ]),
  tmpl("daily", "每日小记", "个人", "📝", `url("covers/coast.jpg")`, [
    heading("h1", "今日小记"),
    para("📅 {{date}}"),
    rule(),
    heading("h2", "三件最有价值的事（今日）"),
    bullet(["完成了：", "推进了：", "学到了："]),
    rule(),
    heading("h2", "情绪与能量"),
    para("今日心情：{{mood}} · 能量：★☆☆☆☆"),
    para("卡住我的事："),
    para("明天想优先解决："),
    rule(),
    quote("一句话总结今天。"),
  ]),
  tmpl("subscription", "会员订购管理", "工作", "🗂", `url("covers/peak.jpg")`, [
    heading("h1", "会员订购"),
    para("集中记录各平台订阅，避免「忘了取消」的隐秘扣费。"),
    rule(),
    heading("h2", "当前订阅"),
    bullet(["iCloud+ —— 2026-12-01 到期 · 21 元/月", "Spotify —— 2026-10-15 到期 · 15 元/月", "ChatGPT Plus —— 2026-09-30 到期 · 20 美元/月"]),
    rule(),
    heading("h2", "提醒规则"),
    bullet(["到期前 7 天提醒", "不常用的到期即取消", "每年一次订阅总览（算总账）"]),
  ]),
  tmpl("movie", "我的观影记录", "个人", "🎬", `url("covers/fjord.jpg")`, [
    heading("h1", "观影记录"),
    para("想看的、看过的，和为什么值得看。"),
    rule(),
    heading("h2", "想看"),
    bullet(["《沙丘2》—— 维伦纽瓦", "《奥本海默》—— 诺兰"]),
    rule(),
    heading("h2", "看过的 · 评分"),
    bullet(["《坠落的审判》—— 已看 ★★★★", "《奥本海默》—— 已看 ★★★★★ 力荐", "《可怜的东西》—— 已看 ★★★☆"]),
    rule(),
    quote("好电影值得二次观看。为喜欢的写一篇长评。"),
  ]),
  tmpl("mood", "情绪日记", "个人", "🌙", `url("covers/mist.jpg")`, [
    heading("h1", "情绪日志"),
    para("记录，是为了不被情绪牵着走。"),
    rule(),
    heading("h2", "今天的情绪"),
    para("心情：{{mood}}（1-10）  ·  能量：{{energy}}"),
    heading("h2", "发生了什么"),
    para("触发事件："),
    para("身体感受："),
    para("我的第一反应："),
    para("更理性的回应："),
    rule(),
    quote("情绪是信使，不是命令。"),
  ]),
  tmpl("fitness", "运动与习惯计划", "健康", "💪", `url("covers/coast.jpg")`, [
    heading("h1", "运动与习惯"),
    para("可持续的进步，来自每一天的小坚持。"),
    rule(),
    heading("h2", "本周目标"),
    bullet(["运动 3 次（周一/三/五）", "每天 8 杯水", "每晚 23:00 前睡"]),
    rule(),
    heading("h2", "打卡记录"),
    para("体重：{{weight}} kg · 体脂：{{fat}}% · 本周体感："),
    bullet(["周一：", "周二：", "周三：", "周四：", "周五："]),
    rule(),
    quote("不追求完美，只追求「持续」。"),
  ]),
  tmpl("calendar", "周历安排", "工作", "📅", `url("covers/peak.jpg")`, [
    heading("h1", "本周安排"),
    para("把最重要的事先放进日历。"),
    rule(),
    heading("h2", "固定日程"),
    bullet(["周一：团队例会 / 周报", "周三：项目评审", "周五：复盘与计划下周"]),
    rule(),
    heading("h2", "本周重点（MOST）"),
    bullet(["最重要的一件事：", "要完成的关键产出：", "要避开的时间陷阱："]),
  ]),
  tmpl("about", "关于我自己", "个人", "🙋", `url("covers/tree.jpg")`, [
    heading("h1", "关于我"),
    rule(),
    heading("h2", "我在做什么"),
    para("我目前专注 / 工作的方向。"),
    heading("h2", "我相信什么"),
    bullet(["原则 1：", "原则 2：", "原则 3："]),
    rule(),
    heading("h2", "我如何协作"),
    bullet(["联系方式：", "我的沟通偏好：", "「我能帮你 / 需要你帮我」："])
  ]),
  tmpl("booknote", "深度读书笔记", "教育", "📖", `url("covers/mist.jpg")`, [
    heading("h1", "《书名》读书笔记"),
    quote("一句话总结这本书（它解决了什么问题 / 改变了什么认知）。"),
    rule(),
    heading("h2", "核心观点"),
    bullet(["观点 1（用自己的话）：", "观点 2：", "观点 3："]),
    heading("h2", "金句摘录"),
    quote("「原文金句，注明页码。」"),
    rule(),
    heading("h2", "我的启发 / 行动"),
    bullet(["它让我重新思考：", "我准备立刻做的一件事："]),
    heading("h2", "一句话荐读"),
    para("值不值得读：…… 给谁读：……"),
  ]),
  tmpl("meeting", "会议纪要", "工作", "🧵", `url("covers/peak.jpg")`, [
    heading("h1", "会议纪要 · {{date}}"),
    para("主题：{{title}} · 主持：{{owner}}"),
    rule(),
    heading("h2", "出席"),
    para("……"),
    heading("h2", "结论 / 决定"),
    bullet(["决定 1：", "决定 2："]),
    rule(),
    heading("h2", "行动项（谁 · 做什么 · 何时）"),
    bullet(["张三 —— 输出方案 —— 周五", "李四 —— 收集数据 —— 下周一"]),
    heading("h2", "待讨论（顺延）"),
    bullet(["……"]),
  ]),
  tmpl("project-review", "项目复盘", "工作", "🔍", `url("covers/fjord.jpg")`, [
    heading("h1", "项目复盘 · {{title}}"),
    quote("回顾，是为了把经验变成下一次的改进。"),
    rule(),
    heading("h2", "目标与结果"),
    bullet(["目标：", "结果（对照，量化）："]),
    heading("h2", "做对了什么（Keep）"),
    bullet(["……"]),
    heading("h2", "哪里可以更好（Improve）"),
    bullet(["……"]),
    rule(),
    heading("h2", "下次行动"),
    bullet(["立即做：", "未来项目借鉴："]),
  ]),
  tmpl("travel", "旅行计划", "个人", "🧳", `url("covers/coast.jpg")`, [
    heading("h1", "「{{title}}」旅行计划"),
    para("时间：{{date}} · 天数：____ 天"),
    rule(),
    heading("h2", "行程（Day by Day）"),
    bullet(["Day 1：到达 · 入住 · ____", "Day 2：____", "Day 3：____"]),
    heading("h2", "清单"),
    bullet(["证件/现金/充电器", "提前订：票 · 住宿 · 门票", "必去：____"]),
    rule(),
    quote("宁可细致，不赶场。留一点意外给惊喜。"),
  ]),
  tmpl("budget", "家庭记账", "个人", "💰", `url("covers/tree.jpg")`, [
    heading("h1", "家庭月度记账 · {{date}}"),
    para("收入：￥____ · 预算：￥____"),
    rule(),
    heading("h2", "固定支出"),
    bullet(["房贷/房租：", "水电/话费：", "保险："]),
    heading("h2", "可变支出"),
    bullet(["餐饮：", "交通：", "购物：", "娱乐：", "医疗："]),
    rule(),
    heading("h2", "本月复盘"),
    para("结余：____ · 超支项：____ · 下月重点：____"),
  ]),
  dbtmpl("content-db", "内容管理库", "工作", "🗃", `url("covers/coast.jpg")`, [
    { name: "标题", type: "text" },
    { name: "状态", type: "select", options: ["未开始", "进行中", "已完成", "阻塞"] },
    { name: "优先级", type: "select", options: ["P0 紧急", "P1 重要", "P2 常规", "P3 可缓"] },
    { name: "负责人", type: "select", options: ["张三", "李四", "王五"] },
    { name: "截止日期", type: "date" },
  ]),
  dbtmpl("gantt", "项目计划·甘特图", "工作", "📊", `url("covers/peak.jpg")`, [
    { name: "开始日期", type: "date" },
    { name: "结束日期", type: "date" },
    { name: "类别", type: "select", options: ["设计", "开发", "测试", "上线", "运营"] },
    { name: "状态", type: "select", options: ["未开始", "进行中", "已完成", "阻塞"] },
    { name: "负责人", type: "select", options: ["张三", "李四", "王五"] },
    { name: "是否完成", type: "checkbox" },
  ]),
  dbtmpl("movie-db", "观影清单", "个人", "🎬", `url("covers/fjord.jpg")`, [
    { name: "片名", type: "text" },
    { name: "导演", type: "text" },
    { name: "评分", type: "number" },
    { name: "状态", type: "select", options: ["想看", "在看", "已看", "力荐"] },
    { name: "年份", type: "number" },
  ]),
];
