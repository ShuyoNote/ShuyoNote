// 应用一条**已由用户确认**的草稿，并把界面刷新到一致状态。
//
// AI 宿主与磁盘插件都走这一条路径 —— 「草稿 → 确认 → 落库」的边界只有一处
// （`lib/ai/apply.ts` 的 applyDraft），刷新逻辑也只有一处，避免两边各写一套而漂移。

import { applyDraft, type ApplyResult } from "./ai/apply";
import { useNotes } from "../store/notes";
import { reseedCrdtStateFromContent } from "./reseedCrdtState";

export async function applyDraftAndRefresh(payload: unknown): Promise<ApplyResult> {
  const res = await applyDraft(payload);
  const notes = useNotes.getState();
  // ⭐ R150：**外部写过的页要打标记** ✓ —— 否则那条排在去抖槽里的旧补丁会在约 0.4 秒后
  //   把它盖回去 ✗（现场读数见 `lib/pendingSave.ts` 的头注 ✓）。
  if (res.ok && res.page) notes.noteExternalWrite(res.page.id);
  // ⭐ **R155**：外部写只进正文列 ⇒ 该页的 CRDT 状态里**没有这段文字** ✗ ⇒ 重启按状态重建会把它盖回去 ✓
  //   （已复现三次 ✓）⇒ 落库之后**按新正文重新播种**这一页的状态 ✓（选项 a，owner 拍 ✓；代价＝丢该页原有血统 ✗）。
  //   ⚠️ 播种失败**不改**落库结果 ✗，但留一行痕 ✓（否则又是一条静的"看着成功"路径 ✗）。
  if (res.ok && res.page) {
    try {
      await reseedCrdtStateFromContent(res.page.id, String(res.page.content_json ?? ""));
    } catch (e) {
      void useNotes.getState().lastExternalWrite;
      try {
        const { api } = await import("./api");
        await api.mcpLogApplyResult(`RESEED_FAIL ${res.page.id}：${String(e)}`.slice(0, 400));
      } catch {
        /* 连留痕都做不了 ⇒ 静默（正文已经落了 ✓，不该把它变成失败 ✗） */
      }
    }
  }
  await notes.loadPages();
  if (res.page) {
    if (res.page.id === notes.currentId) {
      // 落库的是**当前页**：编辑器自己持有 Lexical state，必须刷新内存副本并
      // bump 一下 reload tick（重挂编辑器重新解析），否则改动看不见。
      notes.updateCurrent({
        title: res.page.title,
        content_json: res.page.content_json,
        content_text: res.page.content_text,
      });
      notes.bumpReload();
    } else {
      // 新建的页面直接打开，用户落到他刚确认的那一页上。
      await notes.openPage(res.page.id);
    }
  }
  return res;
}
