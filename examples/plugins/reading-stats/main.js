// @ts-check
// 只读插件示例：不碰笔记内容，只要一项低风险权限。
// 注意 `api.pages.*` 的作用域是**当前活动空间**——锁定/未打开的空间读不到，
// 也不会因为插件去隐式解锁它。

register({
  id: "reading-stats.overview",
  title: "空间概览：页面数与最近更新",
  description: "显示本空间共有多少页，以及最近更新的几页",
  run: function () {
    var total = api.pages.count();
    var recent = api.pages.list(5);

    if (total === 0) {
      api.notify("这个空间还没有页面");
      return "空空间";
    }

    var lines = recent.map(function (p) {
      return "· " + p.title + "（" + p.updated_at + "）";
    });
    api.log("空间概览：" + total + " 页\n" + lines.join("\n"));
    api.notify("共 " + total + " 页，最近更新：" + recent[0].title);
    return total + " 页";
  }
});
