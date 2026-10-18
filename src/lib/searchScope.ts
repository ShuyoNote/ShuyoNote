// 「全空间搜索」在**未输入主口令**时的口径（2026-10-18，owner 报「桌面版，未输入主口令时，全空间搜索不可用」）。
//
// ## 背景（两半都改过，别只改一半）
// · 内核侧（`src-tauri/src/search.rs`）：旧写法 `open_space_conn(&sid)?` ⇒ **任何一个**加密空间
//   没解锁就整次 `Err` ⇒ 界面只显示「无结果」。现在改成**能搜的照搜、搜不了的跳过** ✓。
// · 界面侧（本文件 ＋ `SearchPanel.tsx`）：跳过的那些**必须说出来** —— 否则用户看到的还是
//   "少了几页却不知道为什么"，与"静默降级"是同一类错 ✗。
//
// ## ⚠️ 判据从哪来（别嗅错误字符串）
// 用 `space_security_overview` 的每空间读数：`encrypted_on_disk && !key_available` ⇒ 这个空间
// 现在打不开 ✓（与 `store/space.ts::refusalNeedsPassphrase` 同一条口径、同一个命令 ✓）。
import type { WorkspaceMeta } from "../types";

/** `space_security_overview` 一行的形状（只取本文件要用的两列）。 */
export interface SpaceSecurityRow {
  space_id: string;
  encrypted_on_disk: boolean;
  key_available: boolean;
}

/**
 * 这次「全空间搜索」里**搜不到**的空间名（未解锁的那些）。
 * ⚠️ 顺序跟随 `spaces`（＝侧栏顺序）⇒ 提示里的名字与用户看到的一致 ✓。
 */
export function lockedSpaceNames(spaces: Pick<WorkspaceMeta, "id" | "name">[], rows: SpaceSecurityRow[]): string[] {
  const locked = new Set(
    rows.filter((r) => r.encrypted_on_disk && !r.key_available).map((r) => r.space_id),
  );
  return spaces.filter((s) => locked.has(s.id)).map((s) => s.name);
}

/** 界面上那一句话（纯函数 ⇒ 判据可直接喂读数 ✓）。 */
export function lockedHintText(names: string[]): string {
  if (names.length === 0) return "";
  const list = names.join("、");
  return `${names.length} 个空间未解锁（${list}），结果不含它们 —— 输入主口令后可一并搜索。`;
}
