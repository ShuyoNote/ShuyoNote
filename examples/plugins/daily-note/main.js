// @ts-check
// 最小可用插件示例：读插件私有数据 → 产出一份草稿 → 提醒用户。
//
// 注意三件事：
//   1. 写能力**不会直接落库**：`api.pages.create()` 只是产出一份草稿，
//      用户在界面上确认后才真正建页（返回值里 `drafted: true` 就是在说这件事）；
//   2. `api.kv.*` 是插件自己的存储，默认按**空间**隔离，随空间一起加密；
//   3. 需要什么权限必须在 manifest.json 里声明并写明理由，否则调用会被后端拒绝。

/** 上次创建日记的日期（YYYY-MM-DD）存在这个键里。 */
var KEY_LAST_CREATED = "last-created";

/** @returns {string} 今天的日期，形如 2026-09-10 */
function today() {
  var d = new Date();
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + month + "-" + day;
}

register({
  id: "daily-note.todo",
  title: "每日笔记：写一条待办",
  description: "追加到**当前打开的页面**（落库前先给你确认）",
  // 触发面：在编辑器里输入 / 就能选到它（写入仍走草稿确认）。
  menus: ["slash"],
  params: [
    { name: "text", label: "内容", type: "string", required: true, placeholder: "要做什么" },
    { name: "minutes", label: "预计分钟", type: "number", default: 25 },
    { name: "urgent", label: "标记紧急", type: "boolean" }
  ],
  run: function (args) {
    var line = "- [ ] " + String(args.text) + "（预计 " + String(args.minutes) + " 分钟）" + (args.urgent ? " ⚡" : "");
    // 省略 pageId → 作用于当前打开的页面。
    // 注意：这里**不能**写"追加到今天的日记页"——建页那步产出的是草稿，页面 id 要等
    // 用户确认后才存在，插件在这次运行里拿不到它（已记入 M11.8 的待办）。
    var draft = api.blocks.append(line);
    return draft.summary;
  }
});

register({
  id: "daily-note.create",
  title: "每日笔记：创建今天的日记",
  description: "在顶层新建「今天日期」页面；今天已经建过就只提醒",
  closeOnRun: true,
  run: function () {
    var date = today();
    var last = api.kv.get(KEY_LAST_CREATED);

    if (last === date) {
      api.notify("今天的日记已经建过了：" + date);
      return "今天已经建过";
    }

    var draft = api.pages.create(date, "## 今天要做\n\n- \n\n## 记录\n\n");
    api.kv.set(KEY_LAST_CREATED, date);
    api.log("已产出创建 " + date + " 的草稿：" + draft.summary);
    return "待确认：" + draft.summary;
  }
});

// 事件钩子：**用户没点任何命令**时也会跑，所以 manifest 里必须声明（用户启用前看得到），
// 而这里没写 `on(...)` 就什么都不会发生——两处都在才算数。
//
// 注意写操作依然走草稿确认：事件触发时你并没有在看确认框，所以宿主会把这次改动
// 汇总成一次确认，而不是替你静默贴上去。
on("page.saved", function (payload) {
  var tag = today();
  var existing = api.tags.list();
  var already = existing.some(function (t) {
    return t.name === tag;
  });
  if (already) {
    api.log("「" + String(payload.title) + "」已有 " + tag + " 标签，跳过");
    return;
  }
  var draft = api.tags.add(tag);        // 省略 pageId → 作用在刚保存的这一页
  api.log("保存后补标签 " + tag + "：" + draft.summary);
});
