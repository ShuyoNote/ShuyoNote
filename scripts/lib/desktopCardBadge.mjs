// 桌面「模板中心卡片浮标」那条判据的**唯一出处** —— ⛔ 门禁里不许再手写第二份 ✗。
//
// ## 为什么单拎出来（这是 owner 2026-10-13 拍的**甲**）
// 它原来长这样（`scripts/verify-mobile-layout.mjs` 的 `if (!dtc.hoverNone) … else 打印"跳过"`）：
//   · 能 hover 的环境 ⇒ `ok(...)` 计 **1** 条；
//   · `(hover: none)`（CI 的 headless 就报这个）⇒ **一条都不产**、只打一行"跳过"✗。
// ⇒ ⭐ **通过数随平台变** ✗：CI 上 `mobile-layout` 数出来 **68**，而 `tests/baseline.json:9` 的下界是
//   **69**（"只增不减"硬约束是**人拍的**、不许下调 ✗）⇒ 那条红挂了半个月 ✓。
// ⛔ 别走"乙"（把平台相关的差写进基线）✗：那样**另一个平台永远对不上** ✓。
// ⇒ 甲：**这条在两种取值下都恰好产出 1 条**（计数与平台无关 ✓），只是期望值按 `(hover: none)` 取 ✓。
//
// ## 两种环境各自的**正确**形状（CSS 的唯一出处）
//   · 能 hover（桌面鼠标）：悬停才出现的 **22px** 浮标 —— `src/App.css:13145-13171`
//     （`.tc-card-del { opacity: 0 }` ＋ `.tc-card:hover .tc-card-del { opacity: 1 }` ✓）；
//   · `(hover: none)`（触屏／CI 的 headless ✓）：`src/App.css:22665-22687` 的
//     `@media (max-width: 768px), (hover: none)` 把它变成 **44×44 且 `opacity: 1`（常驻）** ✓
//     —— 触屏永远没有 hover，靠 `:hover` 显形的 22px 等于"删不掉、导不出自己的模板" ✓
//     （同一件事在窄视口那一段也断言过：`verify-mobile-layout.mjs` 的 `.tc-card-actions` 那条 ✓）。
//
// ⭐ 导出这个纯函数是为了**判据能注入两种 hover 取值** ✓ —— 本门禁本体要**真 Chromium ＋ dev server**
// ✗，判据跑不动它（见 `scripts/verify-mobile-layout.test.mjs` ✓）。
export function desktopCardBadgeChecks({ hoverNone, boxPos, delOpacity, delW }) {
  // ⭐ 甲（2026-10-13）：**两种取值下都产 1 条** ✓ —— 期望值按 `(hover: none)` 取，⛔ 不再跳过 ✗。
  //    为什么这不是"把判据放松"：原来那条在 `(hover: none)` 下**一次都没跑** ✗（等于零验收）；
  //    现在它**每台机器都跑**，而且钉住的正是**那台机器上对的形状** ✓ —— 计数与平台无关 ✓，
  //    语义反而更严 ✓（CI 的 headless 从此也真的验了"触屏那档是 44×44 常驻"✓）。
  const wantOpacity = hoverNone ? "1" : "0";
  const wantSize = hoverNone ? "≥44（触屏：常驻，否则等于删不掉）" : "≤24（悬停才显形的 22px）";
  const sizeOk = hoverNone ? delW >= 44 : delW <= 24;
  return [
    {
      ok: boxPos === "absolute" && delOpacity === wantOpacity && sizeOk,
      msg:
        `桌面卡片操作仍是浮标（position=${boxPos} / opacity=${delOpacity}（期望 ${wantOpacity}）/ w=${delW}）` +
        `——本机 (hover: none)=${hoverNone} ⇒ 尺寸期望 ${wantSize}`,
    },
  ];
}
