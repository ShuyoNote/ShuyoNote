// @ts-check
// 一方参考插件：**只读 + 报告草稿**，并示范"逐个页面查一次"这种调用形态。
//
//   1. `api.backlinks.list(id)` 一次只查一个页面，所以这里对每篇页面各调一次——
//      这类"逐页巡检"是插件的常见形态，用量上限要自己把住（见下面的 SCAN_LIMIT）；
//   2. **刚建的页面不算孤岛**：新建的页面本来就还没人链过去，把它们列出来只会让用户觉得
//      这个插件在制造噪音——所以按 `created_at`（而不是 `updated_at`，它会被编辑刷新）
//      只看创建超过 7 天的；
//   3. 产出的是**草稿**：用户确认后才落库，与所有写能力一样。
register({
  id: "orphan-pages.scan",
  title: "找出孤立页面",
  description: "列出没有任何反向链接的页面，生成一篇清单草稿（确认后落库）",
  params: [
    { name: "minAgeDays", label: "创建超过几天才算", type: "number", default: 7 },
    { name: "limit", label: "最多列出几篇", type: "number", default: 30 }
  ],
  run: function (args) {
    var minAgeDays = Number(args.minAgeDays || api.settings.get("minAgeDays") || 7);
    var limit = Number(args.limit || 30);
    if (!(minAgeDays >= 0)) minAgeDays = 7;
    if (!(limit > 0)) limit = 30;
    limit = Math.min(limit, 100);

    // 逐页巡检是 O(N) 次调用：这里的上限是**行为边界**，不是刻意抠性能
    var SCAN_LIMIT = 200;
    var pages = api.pages.list(SCAN_LIMIT);
    if (pages.length === 0) return "这个空间还没有页面";

    var ageCutoff = Date.now() - minAgeDays * 24 * 3600 * 1000;
    var orphans = [];
    var scanned = 0;
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (Number(p.created_at) < ageCutoff) {
        scanned++;
        if (api.backlinks.list(p.id).length === 0) orphans.push(p);
      }
    }
    if (orphans.length === 0) {
      api.notify("扫描的 " + scanned + " 篇页面都有入链，没有孤岛");
      return scanned === 0 ? "没有符合条件的页面（都太新）" : "没有孤立页面";
    }

    var lines = ["# 孤立页面", "", "扫描了 " + scanned + " 篇（创建超过 " + minAgeDays + " 天），其中 " + orphans.length + " 篇没有任何页面链到：", ""];
    for (var j = 0; j < orphans.length && j < limit; j++) {
      lines.push("- " + String(orphans[j].title || "（无标题）"));
    }
    if (orphans.length > limit) lines.push("- …还有 " + (orphans.length - limit) + " 篇");

    var title = "孤立页面（" + orphans.length + " 篇）";
    api.pages.create(title, lines.join("\n"));
    return "扫到 " + orphans.length + " 篇孤岛，已生成「" + title + "」草稿（确认后落库）";
  }
});
