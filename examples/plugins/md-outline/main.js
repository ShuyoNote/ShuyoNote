// @ts-check
// 导入触发示例：用户选一个文件，宿主读成文本后交给这个命令。
//
// 这个示例要钉住两件事（它们正是这套设计想表达的）：
//   1. **读文件的是宿主，不是插件**：插件里没有 fs / fetch，它拿到的只有这一次调用的入参
//      `{ fileName, content }`——fileName 是**文件名**（不含路径），插件也拿不到更多；
//   2. **导入触发不绕过写中介**：这里要新建页面，走的仍是 `api.pages.create` ——
//      产出的是**草稿**，用户确认后才落库。触发方式不改变这条链路。
//
// 声明在 manifest.json 里（作者写命令、宿主加入口）：
//   "triggers": [ { "kind": "import", "extensions": [".md", ".markdown"],
//                   "command": "md-outline.fromFile" } ]
register({
  id: "md-outline.fromFile",
  title: "把 Markdown 标题抽成大纲",
  description: "选中 .md 后：抽出它的标题，新建一篇「大纲：文件名」页面（草稿，需你确认）",
  run: function (args) {
    var name = String(args.fileName || "未命名");
    var text = String(args.content || "");
    if (!text.trim()) return "这个文件是空的，什么都没做";

    var lines = text.split(/\r?\n/);
    var outline = [];
    for (var i = 0; i < lines.length; i++) {
      var m = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i]);
      if (!m) continue;
      var indent = "";
      for (var d = 1; d < m[1].length; d++) indent += "  ";
      outline.push(indent + "- " + m[2]);
    }
    if (outline.length === 0) {
      return name + " 里没有找到标题（# 开头的那几行）——什么都没做";
    }

    // 写能力：产出草稿，用户点「确认」才真的建页面。
    api.pages.create("大纲：" + name, outline.join("\n"));
    return "从 " + name + " 抽到 " + outline.length + " 个标题（确认草稿后落库）";
  }
});
