// 诊断/体检文案用的两个**中立小函数**（`agoText` / `plainText`）。
//
// ## 为什么单独一个文件（这不是"为了拆而拆"）
// 它们本来住在 `meshDiagnose.ts` 里，而 §13.6 O1 的 `meshSyncGraph.ts` 也要用。
// 直接让 `meshSyncGraph` 从 `meshDiagnose` 导，会造出 **`meshDiagnose` ↔ `meshSyncGraph` 循环 import** ——
// 本仓为这种形状付过代价（`scripts/lib/gates.mjs` 里 `check-*` 那条 incident 原话：
// 「节点表在**模块顶层**求值 ＋ 循环 import ⇒ dev/vitest 走原生 ESM 永远绿，
//   打包拼平后 `nodes[9]` 是 `undefined`」）。
// ⇒ 把共用件下沉到**不依赖任何东西**的这里，两边都只往里指（有向无环）。
//
// ⚠️ 纯函数：不读环境、不读时钟（`agoText` 的输入就是毫秒差）。

/** 毫秒 → 人话（只用于诊断文本/体检原因；⛔ 不算"多久没同步"这类业务结论）。 */
export function agoText(ms: number | null): string {
  if (ms === null) return "还没有成功记录";
  if (ms < 1000) return "刚刚";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 诊断包里的原因写成**纯文本**：后端原文可能带行内 Markdown 的 `**`（如 `round.note`），
 *  诊断包是给人贴进聊天框/工单的 ⇒ 只去掉成对标记本身，⛔ 不吞字、⛔ 不改语义。 */
export function plainText(s: string): string {
  return s.replace(/\*\*/g, "");
}
