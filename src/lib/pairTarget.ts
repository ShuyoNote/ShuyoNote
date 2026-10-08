// ⭐ 2026-10-08（owner：「附近设备同步流程太繁琐了，能简化吗？」⇒ 选 A ✓）
//   配对有两态：**选中对端** ⇒ 本机生成时就把它登记好 ⇒ **对面采纳一次、两个方向都通** ✓；
//   **不选** ⇒ 码离线传、**要配两次** ✗。默认是"不选" ⇒ 用户默认掉进繁琐那条 ✗。
//   这里把「要不要替用户自动选中」变成**纯函数** ⇒ 可以**常驻单测** ✓（判据不靠肉眼 ✓）。

export interface PairCandidate {
  device_id: string;
}

/**
 * 自动选中对端的口径（唯一出处 ✓）：
 * · 用户**已经选过**（含主动选"不指定"）⇒ **一律不覆盖** ✓（不能把用户的决定改掉 ✓）；
 * · 候选**恰好一台** ⇒ 选它 ✓（这就是那条"一次双向"的正路 ✓）；
 * · 候选 **0 台 / 多台** ⇒ **不选** ✓ —— ⛔ 多台时**不许替用户挑** ✗（挑错＝连错设备 ✓）。
 */
export function autoPickPeer(candidates: PairCandidate[], current: string): string {
  if (current) return current;
  return candidates.length === 1 ? candidates[0].device_id : "";
}
