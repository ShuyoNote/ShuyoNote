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

// 事件钩子示例：订阅「打开页面」——只有 manifest 里声明了、且这里注册了，
// 两处都在才会收到（缺一处都不会有任何提示，这是有意的设计）。
on("page.opened", function (payload) {
  api.log("打开了 " + String(payload.pageId));
});
