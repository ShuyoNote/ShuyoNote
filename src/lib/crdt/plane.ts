// Slice B 的**平面开关**：把"保存/加载要不要经过 ydoc 平面"收成一个默认关闭的开关
// （施工单 `docs/plans/2026-09-23-crdt-slice-b-workorder.md` §2/§3）。
//
// 本文件**只做一件事**：提供开关 ＋ 一个"关着时**逐字节原样返回**"的薄壳。
// 它现在**不接入任何保存路径** —— 先把最承重的那条判据（关掉 ⇒ 逐字节等价）钉死，
// 等口径拍板（混版本降级 / 空页 id / 派生口径）再谈接线。这样接线那天，"关掉时的行为"
// 已经被判据守着，不是靠人记得。
import { roundTripContentJson } from "./contentJsonYDoc";

/**
 * 默认**关闭**。
 *
 * ⚠️ 语义只有一条，判据也只看这一条：**关着的时候，任何输入都必须原样出来**
 * （不是"内容等价"，是**逐字节**）。迁移不许改未开启用户的行为。
 */
let enabled = (() => {
  try {
    return String(import.meta.env?.VITE_CRDT_PLANE ?? "") === "1";
  } catch {
    return false;
  }
})();

export function isCrdtPlaneEnabled(): boolean {
  return enabled;
}

/** 只给判据/将来的设置项用：显式开关这个平面（默认值就是 false）。 */
export function setCrdtPlaneEnabled(next: boolean): void {
  enabled = !!next;
}

/**
 * 让一份落盘形态的 `content_json` 过一遍（或不经过）CRDT 平面。
 *
 * - 关着：**原样返回同一个字符串**（同一引用 —— 判据据此断言"逐字节"而不是"内容等价"）；
 * - 开着：走 Slice A 的唯一实现往返一次（`roundTripContentJson`）。
 */
export function throughCrdtPlane(contentJson: string): string {
  if (!enabled) return contentJson;
  return roundTripContentJson(contentJson);
}
