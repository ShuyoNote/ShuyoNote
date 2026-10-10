// **`office-import://request` 的前端监听**（task-14 ②）—— 形状抄 `src/lib/deepLinkBridge.ts` ✓。
//
// ## 它接的是哪一半
// Rust 侧（task-10 已落 ✓）：
//   `office_import.rs` 认 `--import <文件>` ⇒ `main.rs` 冷启动解析 ⇐ 记进进程
//   ⇒ `lib.rs` 的单实例回调转发（**第二个实例**）＋ `.setup()` 里 `deliver_pending`（**冷启动**）
//   ⇒ 两条都 `emit("office-import://request", <路径>)` ✓
// 本模块：**订阅那个事件 ⇒ 调 `importOfficeFromPath` ⇒ 真的建页** ✓（这正是 task-14 要补的"最后一厘米" ✓）。
//
// ## ⚠️⚠️ 一条**已知缺口**（如实写在这里，⛔ 不假装它不存在 ✗）
// `deepLinkBridge.ts` 为什么要"**先订阅、再 drain 队列**"两条腿？看它文件头第 17-23 行：
// **冷启动那条事件在前端挂载之前就发过了** ✗（主窗口 `visible(false)`、插件 setup 时 emit）
// ⇒ 只订阅会**稳定漏掉第一次**，而第二次正常（"第一次不灵"最容易被人当成偶发 ✗）。
//
// ⚠️ 本桥**目前只有订阅这一条腿** ✗ —— `lib.rs` 的 `.setup()` 里那次 `deliver_pending` 同样早于
// 前端挂载 ⇒ **冷启动**（应用没开时双击 .docx）那一路**会丢** ✗。
// ⛔ 补齐它需要 Rust 侧加一个"**取走即空**"的队列命令（深链那个 `deep_link_take` 的同形 ✓）
//   ＋ `src/lib/platform/commands.ts` 的 CommandMap 一条 ⇒ **那要动 `lib.rs`／`commands.ts`**，
//   两者**都不在本轮写域** ✗ ⇒ 如实记为缺口（见报告），⛔ 不当成"冷启动也能用" ✗。
//
// ⭐ **已经能用的那一路（也是 owner 要的那一条）**：应用**已经开着**时再双击 ⇒ 起第二个进程
//   ⇒ 单实例插件把 argv 交给**已在跑的**那个实例 ⇒ 事件在前端**已挂载之后**到达
//   ⇒ 本桥收到 ⇒ 建页 ✓（用户看到的正是"双击就导入" ✓）。

import { platform } from "../platform";
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
   * 不依赖真宿主也能验"事件一到就交给 handler 并且处理它" ✓。
   */
  listen?: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
}

/**
 * 订阅 `office-import://request`。返回**卸载函数**（React effect 直接返回它 ✓）。
 *
 * 失败姿态抄 `deepLinkBridge.ts`：**吞掉异常但记一条 console.error**，不让它冒泡成未捕获拒绝 ✓
 * —— 这是"外来的、非用户主动触发"的输入，为它打断启动流程比丢一条请求更糟 ✓；
 * 而"失败要说出原因"那条由 `handler` 的**返回值**保证（它从不抛 ✓）。
 */
export async function mountOfficeImportRequests(
  handler: OfficeRequestHandler,
  options: MountOfficeRequestsOptions = {},
): Promise<() => void> {
  const listen =
    options.listen ??
    ((event, cb) => platform.event.listen(event, cb as (e: { payload: unknown }) => void));

  const off = await listen(OFFICE_IMPORT_EVENT, (event) => {
    // ⚠️ 必须写成**异步函数调用**（不是 `Promise.resolve(handler(...))`）：后者会先把 handler
    //    执行掉再包 Promise，于是同步抛出的错会漏出这个函数、`.catch` 接不到 ✓
    //    （这个坑是 `deepLinkBridge.test.ts` 抓出来的，这里照抄那个形状 ✓）。
    void (async () => handler(String(event?.payload ?? "")))().catch((e) => {
      console.error("[ShuyoNote] Office 导入请求处理失败（已记日志，不影响应用其余部分）:", e);
    });
  });

  return () => off();
}
