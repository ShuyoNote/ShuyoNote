// 应用一条**已由用户确认**的草稿，并把界面刷新到一致状态。
//
// AI 宿主与磁盘插件都走这一条路径 —— 「草稿 → 确认 → 落库」的边界只有一处
// （`lib/ai/apply.ts` 的 applyDraft），刷新逻辑也只有一处，避免两边各写一套而漂移。

import { applyDraft, type ApplyResult } from "./ai/apply";
import { useNotes } from "../store/notes";

export async function applyDraftAndRefresh(payload: unknown): Promise<ApplyResult> {
  const res = await applyDraft(payload);
  const notes = useNotes.getState();
  // ⭐ R150：**外部写过的页要打标记** ✓ —— 否则那条排在去抖槽里的旧补丁会在约 0.4 秒后
  //   把它盖回去 ✗（现场读数见 `lib/pendingSave.ts` 的头注 ✓）。
  if (res.ok && res.page) notes.noteExternalWrite(res.page.id);
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
