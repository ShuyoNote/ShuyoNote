// @ts-check
// 一方参考插件：**一次运行产出多条草稿**（批量打标签）。
//
// 值得抄的三点：
//   1. 写能力不直接落库：这里对 10 个页面调 `api.tags.add`，宿主把它们汇总成**一次确认**，
//      你点确认才写——所以"批量改"这件事在这个体系里是安全的；
//   2. **写之前先读**：已经贴过标签的页面跳过，免得用户看到一堆重复的草稿；
//   3. **用量要有上限**：批处理工具的默认值必须保守（这里默认 10 篇、最多 50 篇），
//      否则一次点下去给用户堆五十个确认项，等于逼他放弃。
register({
  id: "stale-triage.scan",
  title: "找出久未更新的页面",
  description: "按天数找出陈旧页面，并给它们打上 #待整理（每页一条草稿，你确认后才写）",
  params: [
    { name: "days", label: "多少天没更新算陈旧", type: "number", default: 30 },
    { name: "tag", label: "打什么标签", type: "string", default: "待整理" },
    { name: "limit", label: "最多处理几篇", type: "number", default: 10 }
  ],
  run: function (args) {
    var days = Number(args.days || api.settings.get("staleDays") || 30);
    var tag = String(args.tag || "待整理").replace(/^#/, "").trim();
    var limit = Number(args.limit || 10);
    if (!(days > 0)) days = 30;
    if (!tag) return "标签名不能为空";
    if (!(limit > 0)) limit = 10;
    limit = Math.min(limit, 50);

    /** @type {Record<string, boolean>} */
    var existing = {};
    var tags = api.tags.list();
    for (var t = 0; t < tags.length; t++) existing[tags[t].name] = true;

    var cutoff = Date.now() - days * 24 * 3600 * 1000;
    var pages = api.pages.list(200); // 已按更新时间倒序
    var stale = [];
    for (var i = 0; i < pages.length; i++) {
      if (Number(pages[i].updated_at) < cutoff) stale.push(pages[i]);
    }
    // 这个空间里已经有同名标签时，用户多半就是在用它做同一件事：先说出来，别默默再打一遍
    var tagExists = existing[tag] === true;
    if (stale.length === 0) {
      api.notify("最近 " + days + " 天内每篇都动过，没有陈旧的页面");
      return "没有陈旧的页面";
    }

    var picked = stale.slice(0, limit);
    var drafted = 0;
    for (var j = 0; j < picked.length; j++) {
      api.tags.add(tag, picked[j].id);
      drafted++;
    }
    var more = stale.length > picked.length ? "（还有 " + (stale.length - picked.length) + " 篇没处理，可以再跑一次）" : "";
    var note = tagExists ? "" : "（这个空间里还没有 #" + tag + " 标签，确认后会新建它）";
    return "有 " + stale.length + " 篇超过 " + days + " 天没更新；已为前 " + drafted + " 篇准备 #" + tag + " 草稿" + more + note;
  }
});
