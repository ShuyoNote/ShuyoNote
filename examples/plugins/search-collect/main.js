// @ts-check
// 一方参考插件：**检索 + 汇总成草稿**（调用面是 `pages.search`）。
//
// 两处值得抄：
//   1. `api.pages.search(q, limit)` 返回 `{ id, title, snippet }`——**片段里带正文**，
//      所以插件处理的是"用户搜出来的内容"，不是整库；批量汇总时也只该用片段；
//   2. 检索词是**用户当场给的**（参数必填）：把别人的搜索词固化进 manifest 没有意义。
register({
  id: "search-collect.run",
  title: "把检索结果整理成一页",
  description: "用关键词检索本空间，把命中整理成一篇清单草稿（确认后落库）",
  params: [
    { name: "q", label: "关键词 / 想找的内容", type: "string", required: true, placeholder: "例如：发布流程" },
    { name: "limit", label: "最多收录几条", type: "number", default: 20 }
  ],
  run: function (args) {
    var q = String(args.q || "").trim();
    if (!q) return "没有填关键词";
    var limit = Number(args.limit || 20);
    if (!(limit > 0)) limit = 20;
    limit = Math.min(limit, 50);

    var hits = api.pages.search(q, limit);
    if (hits.length === 0) {
      api.notify("没有找到和「" + q + "」相关的页面");
      return "没有命中，什么都没生成";
    }

    var lines = ["# 检索：" + q, "", "命中 " + hits.length + " 篇。", ""];
    for (var i = 0; i < hits.length; i++) {
      lines.push("## " + String(hits[i].title || "（无标题）"));
      var snippet = String(hits[i].snippet || "").trim();
      if (snippet) lines.push("", "> " + snippet.replace(/\n/g, " "));
      lines.push("");
    }

    var title = "检索：" + q + "（" + hits.length + "）";
    api.pages.create(title, lines.join("\n").trim());
    return "命中 " + hits.length + " 篇，已生成「" + title + "」草稿（确认后落库）";
  }
});
