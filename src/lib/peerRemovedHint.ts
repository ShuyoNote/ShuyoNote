// U2 C4（owner 2026-11-12 ③A）：**被移出的一方要如实说**，⛔ 不许只说"同步失败"。
//
// 判据口径（为什么不能只判 401）：401 有两种完全不同的处境 ——
//   ① 这台和对方**从来没配对过** ⇒ 该走「接入/邀请」；
//   ② 曾经配对过、现在对端回了 401（"这个空间里没有登记过这台设备的公钥"）⇒ 多半**已被移出**。
// 界面必须把这两种分开说（否则用户会反复排查网络/重启）。
//
// 唯一实现放在这里（⛔ 不在组件里散写字符串）：`peerRemovedHint(error, everPaired)`。

/** 曾被信任过、现在对端不认 ⇒ 很可能被移出。 */
export const PEER_REMOVED_HINT =
  "对端已不再信任这台设备（很可能已被移出）。需要重新邀请/配对才能继续同步；本机数据不会动。";

/** 从来没配对过 ⇒ 先配对再说。 */
export const PEER_NOT_PAIRED_HINT =
  "这一台和本机还没配对过：先走「接入」或邀请配对，再重试同步。";

/** 服务端 401 的实名文案（Rust 侧逐字出这句；不要改它的措辞，只做**包含**判断）。 */
const NOT_TRUSTED_MARKERS = [
  "没有登记过这台设备的公钥",
  "没被信任过",
  "已被移出",
  "没通过，而且口令那一档也没出示",
];

/**
 * 把一个对端拉取的 `error` 翻成"被移出/没配对"的人话；不是这两类 ⇒ `null`（交给原来的错误展示）。
 *
 * @param error Rust 侧那一行的 `error` 原文（`null` = 这一台这一轮没问题）
 * @param everPaired 本机名单里是否还有这一台（有 ⇒ 曾被信任过）
 */
export function peerRemovedHint(error: string | null | undefined, everPaired: boolean): string | null {
  if (!error) return null;
  const s = String(error);
  const notTrusted = NOT_TRUSTED_MARKERS.some((m) => s.includes(m));
  if (!notTrusted) return null;
  return everPaired ? PEER_REMOVED_HINT : PEER_NOT_PAIRED_HINT;
}

/** 从一轮网格读数里挑出第一条"被移出/没配对"提示（没有 ⇒ `null`）。 */
export function findPeerRemovedHint(
  round: { peers: { peer: string; error: string | null }[] } | null | undefined,
  everPaired: (peer: string) => boolean,
): string | null {
  for (const p of round?.peers ?? []) {
    const h = peerRemovedHint(p.error, everPaired(p.peer));
    if (h) return h;
  }
  return null;
}
