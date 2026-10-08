// 应用一条**已由用户确认**的草稿，并把界面刷新到一致状态。
//
// AI 宿主与磁盘插件都走这一条路径 —— 「草稿 → 确认 → 落库」的边界只有一处
// （`lib/ai/apply.ts` 的 applyDraft），刷新逻辑也只有一处，避免两边各写一套而漂移。

import { applyDraft, type ApplyResult } from "./ai/apply";
import { api } from "./api";
import { useNotes } from "../store/notes";

export async function applyDraftAndRefresh(payload: unknown): Promise<ApplyResult> {
  const res = await applyDraft(payload);
  const notes = useNotes.getState();
  // ⭐ R150：**外部写过的页要打标记** ✓ —— 否则那条排在去抖槽里的旧补丁会在约 0.4 秒后
  //   把它盖回去 ✗（现场读数见 `lib/pendingSave.ts` 的头注 ✓）。
  if (res.ok && res.page) notes.noteExternalWrite(res.page.id);
  // ⭐ **R155**：外部写只进正文 ⇒ 该页的 CRDT 状态里**没有这段文字** ✗ ⇒ 重启按状态重建会把它盖回去 ✓
  //   （已复现三次 ✓）⇒ 落库之后**按新正文重新播种**这一页的状态 ✓（选项 a，owner 拍 ✓；代价＝丢该页原有血统 ✗）。
  //   ⚠️ 播种失败**不改**落库结果 ✗，但要留一行痕 ✓（否则又是一条静的"看着成功"路径 ✗）。
  // ⭐ **R155（机制①，owner 2026-10-08 拍 A ✓）**：外部写只进正文 ⇒ 若沿用库里那份**旧状态** ✗，
  //   编辑器绑定会**拿它当基底** ⇒ 写出旧状态 ⇒ 重启按旧状态重建 ⇒ 正文回退 ✓（已复现三次 ✓）。
  //   ⇒ **清空该页状态**（仓内先例 `LineageConflictBanner.tsx:83` ✓）⇒ 绑定**按落盘正文 bootstrap** ✓
  //   ⇒ 由**绑定**写出含新正文的状态 ✓（**单一写者** ✓；我先前自己播种那版会在 9ms 后被它盖回去 ✗）。
  //   ⚠️ **次序是全部关键**：必须排在下面 `loadPages()`／`openPage()`／`bumpReload()` **之前** ✗。
  if (res.ok && res.page) {
    try {
      // ⭐ R155 诊断（正面留痕 ✓ —— 上一次我把仪器删了才去猜结论 ✗，这次先装回来 ✓）：
      //   用来看清空到底**有没有进库** ✓、以及它是不是**又被绑定盖回去** ✓。
      await api.mcpLogApplyResult(`CRDT_CLEAR start ${res.page.id}`.slice(0, 400));
      // ⚠️ **过渡修法（可回退 ✓）**：读数逐字 —— 我清空**成功**（1 毫秒 ✓），而**活着的绑定**
      //   在 **11 毫秒后**又把旧状态写回（440 字节 ✗）⇒ 清空必须排到它那次保存**之后** ✓。
      //   正解是"**硬重挂绑定**"（丢弃内存文档 ⇒ 由绑定按落盘正文 bootstrap ✓），那一步落在
      //   `pageBinding`／`Editor` 那条线（windows ✓，已发信 ✓）；这里先用**延后清空**过渡 ✓。
      await new Promise((r) => setTimeout(r, 500));
      await api.savePageState(res.page.id, new Uint8Array());
      await api.mcpLogApplyResult(`CRDT_CLEAR done ${res.page.id}`.slice(0, 400));
    } catch (e) {
      try {
        await api.mcpLogApplyResult(`CRDT_CLEAR_FAIL ${res.page.id}：${String(e)}`.slice(0, 400));
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
