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
  tmpl("library", "我的个人图书馆", "个人", "📚", "linear-gradient(135deg, #f6d5b3 0%, #e8a87c 100%)", [
    heading("h1", "我的个人图书馆"),
    quote("在这里汇总读过的书、摘录与感悟。"),
    rule(),
    heading("h2", "想读"),
    bullet(["《被讨厌的勇气》", "《原则》", "《置身事内》"]),
    rule(),
    heading("h2", "在读"),
    bullet(["《克拉拉与太阳》——进度 40%", "《人类简史》——进度 20%"]),
    para("读完一本，就把它移到「已读」并补一条短评。"),
  ]),
  tmpl("daily", "每日小记", "个人", "📝", "linear-gradient(135deg, #c4e0f9 0%, #8ec5ff 100%)", [
    heading("h1", "今日小记"),
    para("日期：{{date}}"),
    rule(),
    heading("h2", "今天"),
    bullet(["完成了：", "卡住了：", "明天："]),
    quote("一句话总结今天。"),
  ]),
  tmpl("subscription", "会员订购管理", "工作", "🗂", "linear-gradient(135deg, #ffd3a5 0%, #fd9850 100%)", [
    heading("h1", "会员订购"),
    para("记录各平台会员的到期时间与续费状态。"),
    bullet(["iCloud+ —— 到期 2026-12-01", "Spotify —— 到期 2026-10-15", "ChatGPT Plus —— 到期 2026-09-30"]),
    para("到期前一周提醒续费或取消。"),
  ]),
  tmpl("movie", "我的观影记录", "个人", "🎬", "linear-gradient(135deg, #d6d9ff 0%, #a3a8ff 100%)", [
    heading("h1", "观影记录"),
    para("想看的、看过的，都记在这里。"),
    bullet(["《沙丘2》——想看", "《奥本海默》——已看 ★★★★★", "《坠落的审判》——已看 ★★★★"]),
    quote("好电影值得二次观看。"),
  ]),
  tmpl("mood", "情绪日记", "个人", "🌙", "linear-gradient(135deg, #c8e6c9 0%, #a5d6a7 100%)", [
    heading("h1", "情绪日志"),
    para("今天的心情：{{mood}}"),
    rule(),
    para("发生了什么？"),
    para("我是怎么回应的？"),
  ]),
  tmpl("fitness", "减肥习惯计划", "健康", "💪", "linear-gradient(135deg, #ffe0b2 0%, #ffb74d 100%)", [
    heading("h1", "运动与习惯"),
    bullet(["每周运动 3 次", "每天 8 杯水", "记录体重每日一次"]),
    rule(),
    para("本周目标：¥——"),
  ]),
  tmpl("resume", "我的简历", "教育", "🎓", "linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%)", [
    heading("h1", "个人简历"),
    para("姓名 / 联系方式 / 求职意向"),
    rule(),
    heading("h2", "教育背景"),
    para("学校 · 专业 · 起止时间"),
    heading("h2", "项目与经历"),
    bullet(["项目 A：", "项目 B："]),
  ]),
  tmpl("calendar", "斜霸日历", "工作", "📅", "linear-gradient(135deg, #fff9c4 0%, #fff176 100%)", [
    heading("h1", "日历"),
    para("本周安排与待办。"),
    bullet(["周一：例会", "周三：项目评审", "周五：周报"]),
  ]),
  tmpl("about", "关于我自己", "个人", "🙋", "linear-gradient(135deg, #b3e5fc 0%, #4fc3f7 100%)", [
    heading("h1", "关于我"),
    para("我是谁 / 我在做什么 / 我相信什么。"),
    rule(),
    bullet(["爱好：", "目标：", "联系我："]),
  ]),
  dbtmpl("content-db", "内容管理库", "工作", "🗃", "linear-gradient(135deg, #d1f0e8 0%, #8ee0c4 100%)", [
    { name: "标题", type: "text" },
    { name: "状态", type: "select", options: ["未开始", "进行中", "已完成"] },
    { name: "优先级", type: "select", options: ["高", "中", "低"] },
    { name: "截止日期", type: "date" },
  ]),
  dbtmpl("movie-db", "观影清单", "个人", "🎬", "linear-gradient(135deg, #e3dcff 0%, #b3a5ff 100%)", [
    { name: "片名", type: "text" },
    { name: "评分", type: "number" },
    { name: "状态", type: "select", options: ["想看", "已看"] },
  ]),
];
