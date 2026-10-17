// 应用一条**已由用户确认**的草稿，并把界面刷新到一致状态。
//
// AI 宿主与磁盘插件都走这一条路径 —— 「草稿 → 确认 → 落库」的边界只有一处
// （`lib/ai/apply.ts` 的 applyDraft），刷新逻辑也只有一处，避免两边各写一套而漂移。

import { applyDraft, type ApplyResult } from "./ai/apply";
import { api } from "./api";
import { stateForExternalWrite } from "./crdt/yDocBridge";
import { seedExternalWriteState } from "./crdt/seedExternalWrite";
import { useNotes } from "../store/notes";

/**
 * ⭐ R155 第二半（2026-10-17 接线）：外部写落库后，**把新正文播种成这一页的 CRDT 状态**。
 *
 * 为什么必须做：外部写只改落盘那份正文（及它的纯文本投影），不碰 `page_crdt`；
 * 而编辑器打开页面时是**先读状态、有状态就载入**（`editor/Editor.tsx` 的 `PageCrdtBinding`）——
 * 于是旧状态会在"重新打开 / 重启"时赢回旧内容，免确认写入等于没落定（现场读数见
 * `crdt/r155Seed.test.ts` 头注与 `crdt/yDocBridge.ts` 的 `stateForExternalWrite` 注释）。
 *
 * ⛔ 有意代价（owner 拍选项 a，台账 R155）：这一页**原有 CRDT 血统丢了**——外部写本来就是
 *    "整篇替换"语义，对齐到 CRDT 上也应当如此。
 *
 * 播种失败**不静默**：`seedExternalWriteState` 会 `console.warn` 并返回 false（写入本身已落盘，
 * 但"重启后可能回滚"这件事必须留下线索）。执行体本身在 `crdt/seedExternalWrite.ts`（纯函数，便于判据）。
 */
const SEED_DEPS = {
  stateFor: (page: { id: string }) => stateForExternalWrite(page),
  saveState: (id: string, state: Uint8Array) => api.savePageState(id, state),
  verify: async (id: string, state: Uint8Array) => {
    const back = await api.readPageState(id);
    if (!back) return "read-null";
    if (back.length !== state.length) return `mismatch(len ${back.length}!=${state.length})`;
    let same = true;
    for (let i = 0; i < back.length; i++) {
      if (back[i] !== state[i]) { same = false; break; }
    }
    return same ? "match" : "mismatch(bytes)";
  },
  report: (line: string) => {
    // 诊断用：播种成败写进 mcp/apply.log（没有 devtools 的窗口也能查 R155 是否生效）
    try {
      void api.mcpLogApplyResult(line);
    } catch {
      // 诊断失败不影响落库
    }
  },
};

export async function applyDraftAndRefresh(payload: unknown): Promise<ApplyResult> {
  const res = await applyDraft(payload);
  const notes = useNotes.getState();
  // ⭐ R150：**外部写过的页要打标记** ✓ —— 否则那条排在去抖槽里的旧补丁会在约 0.4 秒后
  //   把它盖回去 ✗（现场读数见 `lib/pendingSave.ts` 的头注 ✓）。
  if (res.ok && res.page) {
    notes.noteExternalWrite(res.page.id);
    // ⭐ R155：落库后播种状态，再刷新界面（顺序不能反：编辑器重挂时会读状态）。
    await seedExternalWriteState(res.page, SEED_DEPS);
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
