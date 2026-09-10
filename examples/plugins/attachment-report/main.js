// @ts-check
// 教学示例：**文件右键菜单**（`file.context`）怎么用。
//
// 要点三条：
//   1. 入口写在 `register({ menus: [...] })` 里（与 `/` 菜单、页面行菜单同一套）；
//   2. 这次调用的入参由**宿主**给：`{ fileName, size, mime }`——就是被你右键的那个文件。
//      **没有绝对路径**：插件本来就没有读文件的能力（能力表里只有 files.list / files.export），
//      给路径只会让人以为能读；
//   3. "当前页"是**这个文件所在的那一页**（不是你现在打开的那一页），所以可以直接用
//      `api.files.list()` 这种省略 pageId 的调用。
//
// 顺带说明为什么这个入口不该声明参数：入参是宿主给的，参数表单不会被渲染；
// 声明了 params 反而会让用户以为要填东西（校验器会提醒）。

/** @param {number} bytes */
function humanSize(bytes) {
  var n = Number(bytes || 0);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

register({
  id: "attachment-report.about",
  title: "这个附件的信息",
  description: "报告被右键的那个附件：名字 / 大小 / 类型，以及它在所属页里排第几",
  menus: ["file.context"],
  run: function (args) {
    var name = String(args.fileName || "(没有名字)");
    var size = humanSize(args.size);
    var mime = String(args.mime || "未知类型");

    // 省略 pageId 的能力调用作用在"当前页"＝这个文件所在的那一页（见上面第 3 条）
    var siblings = api.files.list();
    var index = -1;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].name === name) {
        index = i + 1;
        break;
      }
    }
    var where = index > 0 ? "所属页第 " + index + " / 共 " + siblings.length + " 个附件" : "所属页共 " + siblings.length + " 个附件";
    api.log("附件信息：" + name + "（" + mime + "，" + size + "）");

    return name + "：" + mime + "、" + size + "，" + where;
  }
});
