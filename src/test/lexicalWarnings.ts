// 挂真 Lexical 编辑器做行为测试时，**Lexical 自己的 dev 构建**会往 stderr 打这条警告：
//
//   updateEditorSync: an editor update (e.g. a command listener that mutates the editor)
//   ran while a read-only context was on the stack. ...
//
// 它不是失败，也不是本仓库代码的问题：只挂 Lexical 自带的 `MarkdownShortcutPlugin`（不挂任何
// 本仓库插件）逐字输入 `# ` 也会打 3 条（已用探针确认）。警告本身说的还是"更新被推迟到新的
// 可写更新，照样生效"——而"到底生没生效"正是测试断言的东西（块类型/文本对不上就会失败）。
//
// 所以这里**只静音这一条**，其余 console.warn 一律照原样输出：不把真警告一起吞掉。
export const LEXICAL_DEV_WARNING_PREFIX = "updateEditorSync:";

/** 静音上面那条 Lexical dev 警告；其余警告原样透出。返回还原函数。 */
export function silenceLexicalDevWarnings() {
  const real = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(LEXICAL_DEV_WARNING_PREFIX)) return;
    real(...args);
  };
  return () => {
    console.warn = real;
  };
}
