// 「待取回的远端版本」那个**数字角标**的数据源 —— **一个轮询，多个订阅者**。
//
// 为什么需要它（2026-09-26 真机收尾时读出来的）：`SyncPanel` 在手机上**同时挂了两个实例**
// （侧栏那颗按钮 ＋ 手机底部那个槽位），而第一版是每个实例各自起一个 30 秒定时器
// ⇒ 同一张表每 30 秒被问**两次**。界面上两处显示同一个数字，本来就该**只有一份真相**。
//
// 形状：模块级单例。
//   · 第一个订阅者来时起定时器（并**立刻读一次** —— 角标不该等 30 秒才准）；
//   · 新订阅者立刻拿到**当前值**（不等下一轮）；
//   · 最后一个走时把定时器停掉（不留一个没人要的轮询）。
//
// ⚠️ 读的仍然是**库里那张队列表**（`list_pending_remote_pages` 的 `total`），**不是**某一轮同步
//    的临时读数 —— 真机现场抓到过"读数说有、清单里没有"那类不一致，角标不许再引入第二份真相。
// ⚠️ 面板自己那条 `loadPendingRemote()`（打开面板/裁决之后）读的是**同一张表**，读完用
//    `publishPendingRemoteTotal` 把值**公布**进来 —— 这样两处永远是同一个数，而且不多读一次。
import { api } from "./api";

/** 对账间隔。与"后台自动同步最慢 5 分钟"无关：这只是把**库里那个数字**刷新一下，很便宜。 */
export const PENDING_REMOTE_POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | undefined;
let current = 0;
const subscribers = new Set<(total: number) => void>();

function notify(): void {
  for (const cb of subscribers) cb(current);
}

/** 重新读一次库里那个数字并公布（定时器每 30 秒走这条）。 */
export async function refreshPendingRemoteTotal(): Promise<void> {
  try {
    const q = await api.listPendingRemotePages(1);
    current = Number(q?.total ?? 0);
  } catch {
    // 读不到 ⇒ **不改数字**：把角标清成 0 会骗人（"没有待裁决的"是另一回事），
    // 而它只是个提示面，不值得打扰用户。
    return;
  }
  notify();
}

/** 把**别处刚读到**的同一个数字公布进来（面板 `loadPendingRemote` 走这条，省一次读）。 */
export function publishPendingRemoteTotal(total: number): void {
  current = Number(total) || 0;
  notify();
}

/**
 * 订阅"待取回页数"；返回退订函数。
 *
 * ⚠️ 定时器**只有一个**（模块级）：第二个及以后的订阅者不会各起一个 —— 这正是第一版的问题。
 */
export function subscribePendingRemoteTotal(cb: (total: number) => void): () => void {
  subscribers.add(cb);
  if (!timer) {
    void refreshPendingRemoteTotal();
    timer = setInterval(() => void refreshPendingRemoteTotal(), PENDING_REMOTE_POLL_MS);
  } else {
    // 已经有定时器在跑 ⇒ 把**现值**给它，别让它等下一轮（否则第二个实例的角标会空 30 秒）
    cb(current);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
