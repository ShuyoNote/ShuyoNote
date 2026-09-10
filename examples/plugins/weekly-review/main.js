// @ts-check
// 一方参考插件：**参数表单 + 设置 + 只读 + 草稿写入**。
//
// 这条命令只做一件事：把"最近 N 天动过的页面"汇成一篇回顾。三处值得抄：
//   1. `params` 声明什么，宿主就渲染什么表单（填完才执行，`args` 收到整理好的对象）；
//   2. 用户在「插件管理 → 设置」里设的值是**默认值**：这次表单填了就用表单的，
//      没填（或没填数字）才退回设置；
//   3. 写操作走 `api.pages.create` —— 它**不建页**，只产出草稿，用户确认后才落库。
register({
  id: "weekly-review.make",
  title: "生成回顾：最近动过的页面",
  description: "把最近几天更新的页面汇成一篇「回顾」草稿（确认后落库）",
  params: [
    { name: "days", label: "回顾最近几天", type: "number", default: 7 },
    { name: "limit", label: "最多列几篇", type: "number", default: 20 }
  ],
  run: function (args) {
    // 表单没填就退回设置（设置也没设过时 settings.get 返回 null，所以自己兜一个默认值）
    var days = Number(args.days || api.settings.get("defaultDays") || 7);
    var limit = Number(args.limit || api.settings.get("defaultLimit") || 20);
    if (!(days > 0)) days = 7;
    if (!(limit > 0)) limit = 20;

    var now = Date.now();
    var since = now - days * 24 * 3600 * 1000;
    var all = api.pages.list(200); // 已按更新时间倒序
    var recent = [];
    for (var i = 0; i < all.length; i++) {
      if (Number(all[i].updated_at) >= since) recent.push(all[i]);
    }
    if (recent.length === 0) {
      api.notify("最近 " + days + " 天没有更新的页面");
      return "最近 " + days + " 天没有更新，什么都没生成";
    }

    var lines = ["# 回顾（最近 " + days + " 天）", ""];
    lines.push("共 " + recent.length + " 篇有更新。");
    lines.push("");
    for (var j = 0; j < recent.length && j < limit; j++) {
      var p = recent[j];
      lines.push("- " + String(p.title || "（无标题）"));
    }
    if (recent.length > limit) lines.push("- …还有 " + (recent.length - limit) + " 篇");

    var title = "回顾：" + days + " 天（" + recent.length + " 篇）";
    api.pages.create(title, lines.join("\n"));
    return "已生成「" + title + "」的草稿（确认后落库）";
  }
});
