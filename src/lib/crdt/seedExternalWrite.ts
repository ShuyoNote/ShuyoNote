// R155 第二半的**纯执行部分**（不 import 任何重依赖 ⇒ 判据可以独立钉它）。
//
// 背景与取舍写在 `yDocBridge.ts` 的 `stateForExternalWrite` 头注：
// 外部写（免确认那条路）只改落盘正文、不碰 `page_crdt` ⇒ 旧状态会在重新打开/重启时赢回旧内容。
// 修法：落库成功后，**用新正文播种一份状态**并写回（整篇替换语义；原有血统按 owner 选项 a 放弃）。
//
// 这里只做"播种 + 写回 + 失败留痕"这一件事；谁调用、什么时候调用由 `applyDraftAndRefresh` 决定。

export interface SeedExternalWriteDeps {
  /** 正文 → CRDT 状态字节（生产实现：`stateForExternalWrite`）。 */
  stateFor: (page: { id: string }) => Uint8Array;
  /** 状态写回（生产实现：`api.savePageState`）。 */
  saveState: (id: string, state: Uint8Array) => Promise<unknown>;
  /**
   * 可选：写回后**立刻回读**一次并给出结论（"match"/"mismatch"…）。
   * 现场：播种日志说 OK、但库里的状态还是旧的 —— 要么写去了别处，要么写回后被覆盖；
   * 回读这一步就是为了把这两者分开（判据也只认这个读数）。
   */
  verify?: (id: string, state: Uint8Array) => Promise<string>;
  /**
   * 可选：把这次播种的结果**留痕到可查的地方**（生产实现接 `api.mcpLogApplyResult`）。
   * 为什么要有：播种失败只 `console.warn` 的话，现场（没有 devtools 的窗口）完全看不见；
   * R155 这条修复是否生效，必须能从 `mcp/apply.log` 读出来（判据也是这么读的）。
   */
  report?: (line: string) => void;
}

/** 返回是否播种成功；**失败不抛**（写入本身已落盘，只把"可能回滚"的事实留痕）。 */
export async function seedExternalWriteState(
  page: { id: string },
  deps: SeedExternalWriteDeps,
): Promise<boolean> {
  const report = (line: string) => {
    try {
      deps.report?.(line);
    } catch {
      // 留痕失败不能反过来影响落库
    }
  };
  try {
    const state = deps.stateFor(page);
    await deps.saveState(page.id, state);
    let verdict = "no-verify";
    if (deps.verify) {
      try {
        verdict = await deps.verify(page.id, state);
      } catch (e) {
        verdict = "verify-threw:" + String(e).slice(0, 80);
      }
    }
    report(`R155-SEED OK page=${page.id} bytes=${state.length} verify=${verdict}`);
    return true;
  } catch (e) {
    // ⛔ 不静默：这条失败意味着"重启后这一页可能回滚"，必须能在控制台与 apply.log 查到。
    console.warn("[crdt] 外部写后播种 CRDT 状态失败（重启/重开可能回滚这一页）", e);
    report(`R155-SEED FAIL page=${page.id} error=${String(e).slice(0, 200)}`);
    return false;
  }
}
