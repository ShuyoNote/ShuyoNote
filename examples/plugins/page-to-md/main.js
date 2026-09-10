// @ts-check
// 一方参考插件：**读当前页 + 导出**（不需要页面 id——`api.blocks.list()` 省略参数
// 就是"当前打开的页面"，与 `api.blocks.append()` 一致）。
//
// 注意两件事：
//   1. `api.files.export()` **不写盘**：它只登记请求，命令跑完后宿主弹系统保存对话框，
//      用户点「保存」才写、点取消就什么都没写；
//   2. 插件拿不到当前页的**标题**（`api.page.current()` 只给 content_json），所以文件名
//      用日期兜底——想要"用页面标题当文件名"，目前只能自己在命令参数里让用户填。
register({
  id: "page-to-md.current",
  title: "把当前页导出成 Markdown",
  description: "把当前页的段落写成一份 .md（保存位置由你选）",
  run: function () {
    var blocks = api.blocks.list(undefined, 300); // 省略 pageId = 当前页
    if (blocks.length === 0) return "当前页没有内容，什么都没导出";

    var paras = [];
    for (var i = 0; i < blocks.length; i++) {
      var text = String(blocks[i].text || "").trim();
      if (text) paras.push(text);
    }
    if (paras.length === 0) return "当前页只有空段落，什么都没导出";

    var d = new Date();
    var pad = function (/** @type {number} */ n) { return (n < 10 ? "0" : "") + n; };
    var stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    var name = "页面-" + stamp + ".md";

    api.files.export(name, paras.join("\n\n") + "\n");
    return "已准备好 " + name + "（" + paras.length + " 段），请在保存对话框里选位置";
  }
});
