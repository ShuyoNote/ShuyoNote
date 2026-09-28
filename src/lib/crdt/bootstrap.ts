// 冲刺 **S9 · 客户端半边**：打开一页时"要不要建血统"的**决策**（纯函数 ＋ 端口）。
//
// 背景（那篇文章第 2 条点名、我们已量化）：**切勿在客户端初始化文档内容** —— 两台设备同时首开
// 同一张**从没建过血统**的页、且各自离线，就会各建一条血统；S8 的护栏只能**发现并拒绝合并**，
// 关不掉窗口。关窗口要有"**首写者裁定**"（服务端一条原子 claim）。
//
// 本文件只做**客户端这一侧的决策**，不碰网络、不碰数据库：
//   · 端口 `PageClaimPort` 由"能跟服务端说话的那一侧"实现（今天没有端点 ⇒ 不接，
//     实现出现在 `shuyonote-sync-server` 加端点之后；**这一侧先等着它**）；
//   · 决策是纯函数 ⇒ 用判据把四条分支钉死，服务端一就位就能直接接上，不用再发明语义。
//
// 四条分支（对应四种现实）：
//   ① 本地已有状态        ⇒ `load-existing`：载入。**不 claim** —— 已有血统的页面不必打扰服务端。
//   ② 没有状态 ＋ claim 成功 ⇒ `mint`：由本机建血统（＝今天 `ensurePageCrdtState` 那一步）。
//   ③ 没有状态 ＋ 别人先 claim 过 ⇒ `wait-for-remote`：**不建**，等/拉对方那条（今天缺端点，
//      所以这条分支暂时走不到；判据先钉着）。
//   ④ 没有状态 ＋ claim 用不了（离线） ⇒ `mint-provisional-offline`：**照旧能离线写**
//      （离线可用性不能让路），但这一条血统是"**未裁定**"的 ⇒ 联网后若撞上 S8 的冲突出口，
//      如实报出来（不静默、也不假装它就是权威）。

/** claim 的结果：`granted` 拿到了／`denied` 别人先拿到／`unavailable` 拿不到（离线/没有端点）。 */
export type ClaimVerdict = "granted" | "denied" | "unavailable";

/** 由"能跟服务端说话的那一侧"实现。**不许**在这一层 import 实现（与 `crdt/plane.ts` 同一纪律）。 */
export interface PageClaimPort {
  /** 原子裁定：`true` ⇒ 本机成为这一页的首写者。失败（网络/超时/没有端点）应当抛。 */
  claim(pageId: string, deviceId: string): Promise<boolean>;
}

/** 打开一页时的四种动作。 */
export type BootstrapDecision =
  | { action: "load-existing" }
  | { action: "mint" }
  | { action: "wait-for-remote" }
  | { action: "mint-provisional-offline" };

/**
 * ★ 决策（纯函数，唯一实现）。
 *
 * ⚠️ `hasLocalState` 优先于 claim：**已经有血统的页永远不 claim、也不重建**
 * （那是 S1 红线"从 JSON 各自新建"的入口）。
 */
export function decideBootstrap(opts: { hasLocalState: boolean; claim: ClaimVerdict }): BootstrapDecision {
  if (opts.hasLocalState) return { action: "load-existing" };
  if (opts.claim === "granted") return { action: "mint" };
  if (opts.claim === "denied") return { action: "wait-for-remote" };
  return { action: "mint-provisional-offline" };
}

/**
 * 调一次 claim 并把"拿不到"归一成 `unavailable`（**离线是正常情况，不是错误**）。
 *
 * ⚠️ 归一成 `unavailable` 而不是抛出去：离线时要能继续写（分支 ④）。但**不静默** ——
 * 返回 `unavailable` 这件事本身就是"这条血统未经裁定"的记录依据，调用方据此走离线分支。
 */
export async function claimVerdict(
  port: PageClaimPort | undefined,
  pageId: string,
  deviceId: string,
): Promise<ClaimVerdict> {
  if (!port) return "unavailable"; // 今天就是这一支（服务端端点还没加）
  try {
    return (await port.claim(pageId, deviceId)) ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}
