// 「能不能把这个端点当云端用」的**唯一**判定处。
//
// ⚠️ **为什么要有这个文件**（2026-10-05）：口径先落在 `store/ai.ts` 里，而**嵌入通道**
// （`lib/semanticEmbed.ts` 的 `embedText`，语义检索用它把标题+正文片段发出去）**没过那道门** ——
// 于是加密空间里正文片段仍可能发往云端。修法不是"再抄一份判定"，而是把判定收成**一处**：
// 两份实现就是两份真相源，它们迟早会分开。
//
// 口径（owner 2026-10-05 更正：「个人版**未加密**空间可以使用云端大模型」⇒ 反过来）：
//   · 本机回环 ⇒ **总是放行**（本机模型不涉及出网）
//   · 当前活动空间**已知**是加密的 ⇒ **拒绝**
//   · 读数**还没取到** ⇒ 放行 ＋ 起一次刷新（有意的取舍，见 `cloudAllowedSync` 注释）
//
// ⚠️ **同步判**是硬要求：三处 transport 创建在时序敏感路径上（分批进度、`stop()` 后作废都有断言），
// 多一个 `await` 就会让进度晚一拍（实测：`ai.summarize.test.ts` 当场两条红）。
// ⇒ 所以读数由调用方**异步填**进这里（`setSpaceSecurityState`），本模块只做同步判、不碰 IPC ——
// 这样也顺带避免了 `api ↔ semanticEmbed` 的循环导入。

import { isLoopbackBase } from "./llm";

/** 拒绝时给用户看的那一句话（store 与嵌入通道共用，避免两处措辞漂移）。 */
export const CLOUD_BLOCKED_MESSAGE =
  "这个空间是加密的，内容不能发给云端大模型（那等于把明文送出本机）。" +
  "请改用本机模型（如 Ollama），或在「空间隐私」里改用未加密空间再配云端。";

let encryptedSpaceIds: Set<string> | null = null;
let activeSpaceId: string | null = null;

/** 由调用方（`store/ai.ts`／AI 设置面板）异步取到读数后写进来。 */
export function setSpaceSecurityState(
  activeId: string | null,
  rows: { space_id: string; encrypted_on_disk: boolean }[],
): void {
  activeSpaceId = activeId;
  encryptedSpaceIds = new Set(rows.filter((r) => r.encrypted_on_disk === true).map((r) => r.space_id));
}

/** 读数取到了没有（UI 用来区分"未知"与"确实未加密"）。 */
export function hasSpaceSecurityState(): boolean {
  return encryptedSpaceIds !== null && activeSpaceId !== null;
}

/** 当前活动空间**已知**是加密的吗（未知 ⇒ false，UI 不许把"未知"说成"安全"）。 */
export function isActiveSpaceKnownEncrypted(): boolean {
  if (!encryptedSpaceIds || !activeSpaceId) return false;
  return encryptedSpaceIds.has(activeSpaceId);
}

/**
 * ⭐ 同步判：本机 ⇒ 放行；当前活动空间**已知**是加密的 ⇒ 拒绝；读数未取到 ⇒ 放行。
 *
 * ⚠️ **"未取到就放行"是有意的取舍** ✗：加密只在桌面档存在，而"第一次判之前"这个窗口
 * 只有一次 IPC 的时间。写入方（AI 设置面板／AI store）会在打开时就把读数填进来 ⇒
 * 真正会配云端的人，在那之前已经填过了。⭐ 写在这里免得后人以为是漏了。
 */
export function cloudAllowedSync(baseUrl: string): boolean {
  if (isLoopbackBase(baseUrl)) return true;
  return !isActiveSpaceKnownEncrypted();
}
