// 深链**投递**（`shuyonote://` 的 OS 层 → 应用内接入缝）—— 只做搬运，不做判断。
//
// ## 职责边界（这条边界是硬的，两侧各有负责人）
//
// - **本模块（OS 层）**：把"操作系统刚把一条 URL 交给应用"这件事**送到应用内**，
//   并保证**三条到达路径一条都不丢**。它只搬 URL 字符串，不认识 `page`/`save`/`import`/`compose`。
// - **接入缝（语义层）**：拿到 URL 后决定"这是什么动作、参数合不合法、要不要弹预览"。
//   目前它长这样：`useCommunitySave.getState().openWithLink(url)`（见 `src/store/communitySave.ts`）。
//
// 所以本模块**不 import 任何 store**，只接收一个 `handler`——这样"投递"与"语义"不会互相
// 拽着走，也便于单独测（`deepLinkBridge.test.ts` 就是这么测的）。
//
// ## 为什么需要一个"桥"而不是在 App.tsx 里直接写两行
//
// 因为**冷启动那条 URL 会丢**，而且丢法很隐蔽：
//
// 1. Rust 侧插件的 `setup`（注册时跑）读到冷启动 argv 就 emit 了事件——但那一刻前端
//    **还没注册监听**（主窗口还是 `visible(false)`，页面都没加载完）；👉 见 `deeplink.rs`；
// 2. 于是"前端挂载时只听事件"会稳定漏掉**第一次**深链，而**第二次正常**——
//    这种"第一次不灵、第二次灵"最容易被人当成偶发。
//
// 所以投递必须**两条腿**：挂载时先 **drain 一次队列**（补收冷启动那条），再**订阅事件**
// （收"应用已开着"那条）。两条都汇进同一个 `handler`。
//
// ## 顺序：先订阅、后 drain（这个顺序是刻意的）
//
// 反过来的话存在一个小窗口：drain 完成之后、订阅生效之前到达的那条 URL 会被漏掉。
// 先订阅就没有这个窗口——代价是理论上同一条 URL 可能被"事件"和"drain"各送一次；
// 但 Rust 侧**取走即空**（`deep_link_take` 是 `mem::take`），所以 drain 拿不到已经
// 被事件消费过的那条。**两边的去重靠同一个队列，不靠猜**。

import { api } from "./api";
import { DEEP_LINK_EVENT } from "./platform/commands";
import { platform } from "./platform";

/** 收到一条深链 URL 时要做什么。返回 Promise 以便串行处理（避免两条链接并发弹两个框）。 */
export type DeepLinkHandler = (url: string) => void | Promise<void>;

/** 卸载函数：React effect 的清理直接返回它。 */
export type DeepLinkUnmount = () => void;

/** 一条 URL 是不是我们该管的（非 `shuyonote:` 一律不送进语义层）。 */
function isOurs(url: unknown): url is string {
  return typeof url === "string" && /^shuyonote:/i.test(url.trim());
}

/**
 * 接上深链投递。**幂等的前提**：每次调用只装一份监听与一次 drain；调用方负责在卸载时
 * 调用返回的函数（否则热更新/重挂会叠出多份监听，同一条链接被处理多次）。
 *
 * 失败的姿态：**吞掉异常但记一条 console.error**，不让它冒泡成未捕获拒绝。
 * 理由：深链是"外来的、非用户主动触发"的输入，为它把整个启动流程打断（或弹一个崩溃屏）
 * 比丢一条链接更糟。而"解析失败要说出原因"那条要求由 `handler` 内部保证
 * （`openWithLink` 会把 `reason` 显示出来），不在这里重复。
 */
export function mountDeepLinks(handler: DeepLinkHandler): DeepLinkUnmount {
  let disposed = false;

  const deliver = (raw: unknown) => {
    if (disposed || !isOurs(raw)) return;
    // 串行 await：两条链接几乎同时到（例如连点两次）时，第二个会等第一个处理完，
    // 不会出现"两个预览框抢同一个 pendingLink"。
    //
    // ⚠️ 必须写成 `(async () => handler(...))()` 这样的**异步函数调用**，不能写
    // `Promise.resolve(handler(raw))`——后者会**先把 handler 执行掉**再包 Promise，
    // 于是 handler 里同步抛出的错会直接漏出这个函数（`deliver` 是同步调用的），
    // `.catch` 根本接不到。这个坑是 `deepLinkBridge.test.ts` 里
    // "handler 抛错不会变成未捕获拒绝" 那条用例抓出来的。
    void (async () => handler(raw))().catch((e) => {
      console.error("[ShuyoNote] 深链处理失败（已记日志，不影响应用其余部分）:", e);
    });
  };

  // 1) 先订阅："应用已经开着、用户又点了一次"这条路径。
  const unlisten = platform.event
    .listen<string[]>(DEEP_LINK_EVENT, (event) => {
      // Rust 侧事件载荷是 `string[]`（原样 URL，未解析）。
      for (const url of event?.payload ?? []) deliver(url);
    })
    .catch((e) => {
      console.error("[ShuyoNote] 深链事件订阅失败（冷启动 drain 仍可用）:", e);
      return () => {};
    });

  // 2) 再补收：冷启动那条——它的事件在前端挂载之前就发过了（见本文件顶部注释）。
  //    队列空 ⇒ 返回空数组 ⇒ 这里什么都不做，即"普通启动零副作用"。
  void api
    .deepLinkTake()
    .then((urls) => {
      for (const url of urls ?? []) deliver(url);
    })
    .catch((e) => {
      console.error("[ShuyoNote] 深链队列读取失败:", e);
    });

  return () => {
    disposed = true;
    void unlisten.then((off) => off());
  };
}
