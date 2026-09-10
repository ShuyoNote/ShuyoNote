/**
 * 宿主事件的**公告口**（零依赖）。
 *
 * 为什么要这么一层：`notes` / `space` / `App` 这些地方只该"播报事实"（打开了页面、
 * 删了页面、切了空间），而不该知道插件、权限、草稿确认这些事。让它们直接 import
 * 插件 store 会立刻绕成循环依赖（插件 → 草稿 → applyDraftAndRefresh → notes → 插件）。
 *
 * 所以：宿主各处调用 `emitHostEvent(...)`，插件层在启动时用 `registerHostEventEmitter`
 * 注册真正的派发实现。没有插件层时这里什么都不做，也不会报错。
 */

export type HostEventEmitter = (event: string, payload?: Record<string, unknown>) => void;

let emitter: HostEventEmitter | null = null;

/** 由插件层在模块加载时注册（见 store/plugins.ts）。 */
export function registerHostEventEmitter(fn: HostEventEmitter): void {
  emitter = fn;
}

/** 播报一个宿主事件。没人听就什么都不发生。 */
export function emitHostEvent(event: string, payload?: Record<string, unknown>): void {
  emitter?.(event, payload);
}

/** 一次附件导入的结果里，宿主真正关心的部分（`count` 就是它的条数）。 */
export interface ImportedFile {
  hash: string;
}

/**
 * 一次同步的结果里，宿主真正关心的部分。
 *
 * 不 import `api.ts` 的 `WorkspaceSyncResult`：那是**平台契约**的形状，这里只要这几个数。
 * （`api.ts` 会 import 本模块，反向 import 就是循环。）
 */
export interface SyncOutcome {
  pushed: number;
  pulled: number;
  error: string | null;
}

/**
 * 播报「一次附件导入结束了」（`import.finished`）。
 *
 * 为什么在这里判空、而不是让调用方各自判：这条事件的语义是"**有东西真的导进来了**"。
 * 用户取消了文件选择、或导入被后端拒绝（返回空数组）时不播报——否则插件会被一个
 * 什么都没发生的"完成"叫醒一次。
 *
 * 返回值只给测试与调用方判断用（不参与派发）。
 */
export function emitImportFinished(files: ImportedFile[], pageId: string | null): boolean {
  if (files.length === 0) return false;
  emitHostEvent("import.finished", { count: files.length, pageId });
  return true;
}

/**
 * 播报「一次同步结束了」（`sync.completed`）。
 *
 * 规则（都有测试）：
 * - **整次调用失败**（全部工作空间都 error）→ 不播报：那不是"同步完成"，插件被叫醒后
 *   按完成去处理反而更糟（比如清掉本地待同步队列）；
 * - 部分成功 → 只累加**成功那些**的 pushed/pulled，不把失败工作空间的 0 混进来当成绩；
 * - 一次都没跑（空数组）→ 不播报。
 */
export function emitSyncCompleted(results: SyncOutcome[]): boolean {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return false;
  const pushed = ok.reduce((n, r) => n + (r.pushed || 0), 0);
  const pulled = ok.reduce((n, r) => n + (r.pulled || 0), 0);
  emitHostEvent("sync.completed", { pushed, pulled });
  return true;
}
