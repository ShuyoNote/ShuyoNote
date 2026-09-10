// @ts-check
// 导出示例：插件**申请**导出，用户决定存不存、存在哪里。
//
// 三条要点：
//   1. `api.files.export(名字, 内容)` **不写盘**——它只登记一次请求，命令跑完后宿主弹系统
//      保存对话框，用户点「保存」才写、点取消就什么都没写（与写笔记一样是「插件申请、
//      用户决定」）；
//   2. `fileName` 只是**建议的名字**：路径给不了（目录部分会被去掉），存到哪里由用户定；
//   3. 返回的 `{ queued: true }` 只表示"请求登记成功"，**不代表已保存**——保存对话框是在
//      这段代码结束之后才弹的，所以别拿它当"保存成功"用。
register({
  id: "index-export.pages",
  title: "把页面清单导出成 Markdown 索引",
  description: "生成一份「- [标题](页面 id)」的清单（保存位置由你选）",
  run: function () {
    var pages = api.pages.list(200);
    if (pages.length === 0) return "这个空间还没有页面，什么都没导出";

    var lines = ["# 页面索引", ""];
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      lines.push("- [" + String(p.title || "未命名") + "](p:" + String(p.id) + ")　*" + String(p.updated_at) + "*");
    }
    var body = lines.join("\n") + "\n";

    // 文件名里不要带路径分隔符（带了也会被去掉）：路径交给用户在保存对话框里选
    api.files.export("页面索引.md", body);
    return "已准备好页面索引（" + pages.length + " 条），请在保存对话框里选位置";
  }
});
