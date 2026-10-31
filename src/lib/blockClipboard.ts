// 块多选「复制」用的纯函数（可单测）：把选中块的文字拼成可粘贴的纯文本。
//
// ⚠️ 2026-10-31（owner 反馈「复制了一段文本，VS Code 里粘不出来」）：块多选工具条的
// 「⧉ 复制」以前**只把块在文档里又插了一份**（duplicate），**根本没写剪贴板** ——
// 用户以为复制了，切到 VS Code 粘出来是空的。现在拆成两个动作：
//   · 「复制」= 写剪贴板（本文件负责把块文字拼好）；
//   · 「复制一份」= 原来的文档内复制（保留，毕竟有人要的就是它）。
export function blocksToPlainText(parts: string[]): string {
  return parts
    .map((p) => (p ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim())
    .filter((p) => p.length > 0)
    .join("\n");
}
