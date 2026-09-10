// @ts-check
// 一方参考插件：**导入触发 + 解析 + 草稿写入**，并示范两件容易忽略的事。
//
//   1. **读文件的是宿主**：`args` 里的 `{ fileName, content }` 是这一次调用的入参，
//      插件依旧没有文件能力；内容上限 1 MiB（够装常见表格，巨表会在宿主那一步被拒）。
//   2. **解析要能容错**：CSV 常见的是引号里有逗号、引号里有换行、字段里有双引号（`""`）。
//      这里只做够用的处理，并在超出处理能力时**明说**，而不是默默生成一张错表。
register({
  id: "csv-table.fromFile",
  title: "把 CSV 转成 Markdown 表格",
  description: "选中 .csv / .tsv 后：转成表格，新建一篇页面草稿（确认后落库）",
  run: function (args) {
    var name = String(args.fileName || "表格");
    var text = String(args.content || "");
    if (!text.trim()) return "文件是空的，什么都没做";

    var delimiter = name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    var rows = parseDelimited(text, delimiter);
    if (rows.length === 0) return "没解析出任何行";

    var header = rows[0];
    var body = rows.slice(1);
    var MAX_ROWS = 200;
    var truncated = false;
    if (body.length > MAX_ROWS) {
      body = body.slice(0, MAX_ROWS);
      truncated = true;
    }

    var lines = ["| " + header.map(escapeCell).join(" | ") + " |"];
    lines.push("|" + header.map(function () { return " --- "; }).join("|") + "|");
    for (var i = 0; i < body.length; i++) {
      var cells = [];
      for (var c = 0; c < header.length; c++) cells.push(escapeCell(body[i][c] === undefined ? "" : body[i][c]));
      lines.push("| " + cells.join(" | ") + " |");
    }
    if (truncated) lines.push("", "（原文件还有更多行，这里只放了前 " + MAX_ROWS + " 行）");

    var title = "表格：" + name;
    api.pages.create(title, lines.join("\n"));
    return "已从 " + name + " 解析 " + (rows.length - 1) + " 行，生成「" + title + "」草稿（确认后落库）";
  }
});

/**
 * 解析分隔符文本：支持 CRLF、引号包裹的字段（含分隔符/换行），以及字段内的 `""` 转义。
 * 只做够用的实现——遇到不可能解析的输入（引号没闭合）就把剩下的内容当作一个字段，
 * 而不是抛错让整个命令失败。
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
function parseDelimited(text, delimiter) {
  var rows = [];
  var row = [];
  var field = "";
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  row.push(field);
  rows.push(row);
  // 去掉最后那个空行（文件以换行结尾时的常见产物）
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

/** Markdown 表格里的单元格：竖线会破坏表格结构，换行会破坏行结构。
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
