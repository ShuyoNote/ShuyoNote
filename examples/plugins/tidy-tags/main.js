// @ts-check
// 演示「读 + 写」两步：先读已有标签（读能力，直接返回），再写（产出草稿）。
// 省略 pageId 时，写能力默认作用在**当前打开的页面**上。

/** @returns {string} 形如 2026-09-10 的日期标签 */
function todayTag() {
  var d = new Date();
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + month + "-" + day;
}

register({
  id: "tidy-tags.today",
  title: "日期标签：给当前页打上今天",
  description: "在当前页加一个 YYYY-MM-DD 标签",
  run: function () {
    var tag = todayTag();
    var existing = api.tags.list();
    var used = existing.some(function (t) {
      return t.name === tag;
    });

    var draft = api.tags.add(tag);
    api.notify(used ? "今天是第 " + countOf(existing, tag) + " 次用到 " + tag : "新标签：" + tag);
    return draft.summary;
  }
});

/**
 * @param {{ id: string; name: string; page_count: number }[]} tags
 * @param {string} name
 * @returns {number}
 */
function countOf(tags, name) {
  for (var i = 0; i < tags.length; i++) {
    if (tags[i].name === name) return tags[i].page_count;
  }
  return 0;
}
