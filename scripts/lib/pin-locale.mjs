/**
 * 把被测页面的语言钉成 **zh-CN**（必须在 `goto` **之前**调用：`evaluateOnNewDocument` 只对之后
 * 的导航生效）。
 *
 * ## 为什么需要它（2026-09-22 实测，CI 恒红而本机恒绿）
 *
 * `src/i18n/index.ts` 的首次语言是 `localStorage["shuyonote:lang"] || 跟随 navigator.language`
 * （`en*` ⇒ 英文）。CI 的 runner 是 **en-US** 浏览器 ⇒ 活动栏标题变成 `Notes` / `Files` / `Board`…，
 * 而三条移动端门禁里到处是**按中文 title 找按钮**（`title^="笔记（编辑器）"` / `"文件管理"` …）
 * ⇒ 每个视图都"打不开"，最后抛
 * `No element found for selector: .activity-group .activity-btn[title^="文件管理"]`。
 * 开发机浏览器是 zh-CN，所以**本地永远复现不出来**。
 *
 * 这里不是"改产品去迎合测试"：产品的**主语言**就是 zh-CN，而门禁里的文案断言也全是中文；
 * 把测试环境钉成主语言，比让每条断言都去兼容 en 更诚实（en 那套另有它自己的覆盖）。
 * 用产品自己的那条键（`shuyonote:lang`），不额外发明开关。
 */
export async function pinAppLanguage(page) {
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("shuyonote:lang", "zh-CN");
    } catch {
      /* 无 localStorage（file:// 等）就跟随系统 —— 与本函数无关 */
    }
  });
}
