// **`office-import://request` 的前端监听**（task-14 ②）—— 形状抄 `src/lib/deepLinkBridge.ts` ✓。
//
// ## 它接的是哪一半
// Rust 侧（task-10 已落 ✓）：
//   `office_import.rs` 认 `--import <文件>` ⇒ `main.rs` 冷启动解析 ⇐ 记进进程
//   ⇒ `lib.rs` 的单实例回调转发（**第二个实例**）＋ `.setup()` 里 `deliver_pending`（**冷启动**）
//   ⇒ 两条都 `emit("office-import://request", <路径>)` ✓
// 本模块：**订阅那个事件 ⇒ 调 `importOfficeFromPath` ⇒ 真的建页** ✓（这正是 task-14 要补的"最后一厘米" ✓）。
//
// ## ✅ 缺口已补（2026-10-10，task-15）：现在**两条腿**（先订阅 ＋ 再 drain）
// `deepLinkBridge.ts` 为什么要"**先订阅、再 drain 队列**"两条腿？看它文件头第 17-23 行：
// **冷启动那条事件在前端挂载之前就发过了** ✗（主窗口 `visible(false)`、插件 setup 时 emit）
// ⇒ 只订阅会**稳定漏掉第一次**，而第二次正常（"第一次不灵"最容易被人当成偶发 ✗）。
//
// ⚠️ 本桥第一版**只有订阅这一条腿** ✗ ⇒ **冷启动（应用没开时双击 .docx）那一路会丢** ✗
//   （而"应用已开着时双击"那一路是好的 ✓）。现在补齐（**与深链桥同形** ✓）：
//   · Rust 侧：`office_import.rs` 把单槽改成 **`Vec` 队列** ＋ 新增命令 `office_import_take`
//     （**取走即空**，与 `deeplink::deep_link_take` 同形 ✓）—— `.setup()` 的交付**只叫醒、不取走** ✓
//   · 本模块：挂载时 **先订阅、再 drain 一次** ✓；**事件只当"叫醒"**，路径一律从 drain 拿 ✓
//   ⇒ 于是 **冷启动**与**第二个实例**两条路都真的走到"建页" ✓，且**同一条路径最多被处理一次** ✓
//     （去重靠"取走即空"的队列本身，⛔ 不靠猜 ✗ —— 同 `deepLinkBridge.ts` 那句"不靠猜" ✓）。

import { isDesktopPlatform, platform } from "../platform";
import {
  importOfficeFromPath,
  realOfficePathDeps,
  type OfficePathDeps,
  type OfficePathOutcome,
} from "./pathImport";

/**
 * ⚠️ 与 `src-tauri/src/office_import.rs::IMPORT_EVENT` **逐字一致**。
 * ⭐ 这条一致性由判据 d 钉着（它直接读那份 .rs 文件比对 ✓）—— 改一边不改另一边会**红** ✓。
 */
export const OFFICE_IMPORT_EVENT = "office-import://request";

export interface OfficeRequestDeps extends OfficePathDeps {
  parentId: string | null;
}

/** 收到一条导入请求（路径）时做什么：返回结果（⛔ 不抛 ⇒ 失败也用返回值说清楚 ✓）。 */
export type OfficeRequestHandler = (path: string) => Promise<OfficePathOutcome>;

/**
 * 造一个请求处理器：**空路径直接拒**（⛔ 不许建出空页 ✗），其余交给 `importOfficeFromPath` ✓。
 * ⚠️ 纯逻辑（依赖注入）⇒ 判据可以在**不起真宿主**的情况下验"收到请求会去建页" ✓。
 */
export function createOfficeImportRequestHandler(deps: OfficeRequestDeps): OfficeRequestHandler {
  return async (path: string) => {
    const trimmed = String(path ?? "").trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        code: "empty_path",
        message: "收到一条空的导入请求（没有路径）⇒ 不建页",
        warnings: [],
      };
    }
    return importOfficeFromPath(trimmed, deps.parentId, deps);
  };
}

/** 真实现的处理器（面板与事件监听共用 ✓ ⇒ ⛔ 不写第二份依赖装配 ✓）。 */
export function realOfficeImportRequestHandler(parentId: string | null): OfficeRequestHandler {
  return createOfficeImportRequestHandler({ parentId, ...realOfficePathDeps(parentId) });
}

export interface MountOfficeRequestsOptions {
  /**
   * 订阅器（默认走 `platform.event.listen` ✓）。**注入是为了判据**：
   * 不依赖真宿主也能验"事件一到就去 drain 并建页" ✓。
   */
  listen?: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  /**
   * **取走**待导入路径（**取走即空** ✓）。默认 = `office_import_take` 命令（仅桌面 ✓）。
   * ⚠️ 注入它是为了判据：不起真宿主也能验"挂载前就在队列里的那条拿得到" ✓。
   */
  takePending?: () => Promise<string[]>;
}

/** 命令名（⭐ 与 `src-tauri/src/office_import.rs::office_import_take` ＋ `lib.rs` 的登记**逐字一致** ✓）。 */
export const OFFICE_IMPORT_TAKE_COMMAND = "office_import_take";

/**
 * 默认 drain：调 `office_import_take`（⭐ 与 `deeplink::deep_link_take` 同形 ✓）。
 * ⚠️ Web 平台上**没有**这条命令（也没有"被 OS 唤起"这回事 ✓）⇒ 直接返回空数组
 * （与桌面"队列空"**同语义** ✓ ⇒ 调用方什么都不做 ✓）。⛔ 不假装 Web 也能被唤起 ✗。
 */
async function takePendingViaCommand(): Promise<string[]> {
  if (!isDesktopPlatform()) return [];
  const taken = await platform.executor.invoke<string[] | null>(OFFICE_IMPORT_TAKE_COMMAND);
  return taken ?? [];
}

/**
 * 接上 `office-import://request`：**先订阅、再 drain 一次** ✓。返回**卸载函数**（React effect 直接返回它 ✓）。
 *
 * ## 为什么必须"两条腿"（这一条是本轮修的那个洞）
 * 冷启动那条路径是在 `lib.rs` 的 `.setup()` 里 `emit` 的 —— 而那一刻**前端还没挂载**
 * （主窗口 `visible(false)`、JS 还没跑）⇒ ⭐ **只订阅会稳定漏掉第一次** ✗（第二次正常）。
 * `deepLinkBridge.ts` 文件头第 17-23 行记的是**同一个坑** ✓ ⇒ 这里照它的形状补上 drain ✓。
 *
 * ## 去重：**靠队列本身，不靠猜** ✓（同 `deepLinkBridge.ts` 那句）
 * - 路径**一律从队列取**（`take` **取走即空** ✓）⇒ 同一条最多被处理一次 ✓；
 * - **事件只当"叫醒"**：handler 不读 payload，而是每次去 drain ⇒
 *   · 事件早于 drain ⇒ handler 先取走 ⇒ 挂载那次 drain 取到空 ✓
 *   · drain 早于事件 ⇒ handler 取到空 ⇒ **不会重复建页** ✓
 * - ⚠️ 顺序（**先订阅、后 drain**）也是刻意的：反过来会有一个"drain 完、订阅还没生效"的窗口 ✓。
 *
 * ## 失败姿态（抄 `deepLinkBridge.ts`）
 * **吞掉异常但记一条 console.error**，不让它冒泡成未捕获拒绝 ✓ —— 这是"外来的、非用户主动触发"的输入，
 * 为它打断启动流程比丢一条请求更糟 ✓；而"失败要说出原因"那条由 `handler` 的**返回值**保证（它从不抛 ✓）。
 */
export async function mountOfficeImportRequests(
  handler: OfficeRequestHandler,
  options: MountOfficeRequestsOptions = {},
): Promise<() => void> {
  const listen =
    options.listen ??
    ((event, cb) => platform.event.listen(event, cb as (e: { payload: unknown }) => void));
  const takePending = options.takePending ?? takePendingViaCommand;

  let disposed = false;
  const logFail = (e: unknown): void => {
    console.error("[ShuyoNote] Office 导入请求处理失败（已记日志，不影响应用其余部分）:", e);
  };

  // ⭐ drain：路径**只从队列取**（取走即空）⇒ 事件与 drain 谁先到都不会重复建页 ✓
  const drain = async (): Promise<void> => {
    if (disposed) return;
    const paths = (await takePending()) ?? [];
    for (const path of paths) {
      if (disposed) return;
      await handler(String(path));
    }
  };

  // 1) **先订阅**："应用已经开着、用户又双击了一次"这条路径 ✓
  const off = await listen(OFFICE_IMPORT_EVENT, () => {
    // ⚠️ 必须写成**异步函数调用**（不是 `Promise.resolve(drain())`）：后者会先执行掉再包 Promise，
    //    于是同步抛出的错会漏出这个函数、`.catch` 接不到 ✓（`deepLinkBridge.test.ts` 抓过这个坑 ✓）
    void (async () => drain())().catch(logFail);
  });

  // 2) **再 drain**：补收冷启动那一次（前端挂载之前 emit 过、没人听 ✓）
  //    ⚠️ 这一条**要 await**：挂载返回时应当已经补收完 ⇒ 调用方不必猜"过多久才建好页" ✓
  try {
    await drain();
  } catch (e) {
    logFail(e);
  }

  return () => {
    disposed = true;
    off();
  };
}
