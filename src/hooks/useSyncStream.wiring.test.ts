// SSE 变更流（近实时推送）的**接线判据**（文本级）。
//
// ⚠️ 与 `webClaimScope.wiring.test.ts` 同一手法、同一已知弱点（**文本级，会被骗**）。
// 它抓的不是"逻辑对不对"（解析逻辑由 `crdt/claimScope.test.ts` 的纯函数判据负责；帧解析与退避由
// Rust `sync_stream::tests` 负责），而是"**接线有没有退回旧形状 / 该连的有没有连上**"——
// 第 45 轮那个 bug 就在接线上：挑"第一个绑定过的档案"会**订到别的空间**上去。
//
// 为什么值得为它写一条会骗人的判据：这段接线**没有别的判据**（它要 `fetch` 的 SSE 流 / Tauri 事件 /
// 平台判断；`test:sync-collab` 验的是服务端与命令面，不验这条订阅选谁、接没接上）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 去掉注释后再断言 —— 与 `scripts/check-capabilities.mjs` 同一手法。
 *  为什么必须去：注释里**引用旧写法/讲语义**（例如"`ping` 不是心跳"）是为了让人看懂，
 *  而文本级断言分不清"代码"与"注释"。（这条不是假想：第一版就栽在"我在注释里抄了一遍旧写法"上，
 *  另一处（`check-release-parity` 的 `--features`）也栽过同一个坑。） */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
const src = read("src/hooks/useSyncStream.ts");
const nearRealtime = read("src/lib/nearRealtime.ts");
const app = read("src/App.tsx");

describe("近实时 · 订阅目标与接线（文本级，防退回旧形状）", () => {
  it("① Web 侧按**当前工作空间**解析绑定，并用解析结果拼 URL（不是「第一个绑定过的档案」）", () => {
    expect(src).toContain("api.getActiveWorkspaceId()");
    expect(src).toContain("resolveWorkspaceSyncScope(");
    // ★ 承重：URL 与令牌都必须来自解析结果
    expect(src).toContain("scope.server");
    expect(src).toContain("scope.spaceId");
    expect(src).toContain("scope.token");
  });

  it("② 旧形状**必须消失**：自己挑第一个档案、自己去掉结尾斜杠", () => {
    expect(src, "又出现了「挑第一个绑定过的档案」的旧形状").not.toContain("profiles.find(");
    expect(src, "又出现了「在 hook 里自己归一地址」的旧形状").not.toContain('replace(/\\/+$/, "")');
  });

  it("③ 推送到达时同步的是**那个工作空间**（不是档案行里的某个字段）", () => {
    expect(src).toContain("syncWorkspace(wsId)");
    expect(src).not.toContain("bound.ws_id");
  });

  it("④ 桌面分支：Rust 订流（`sync_stream_start/stop`）＋ 监听事件，且**先挂监听再起流**", () => {
    expect(src).toContain("api.syncStreamStart(");
    expect(src).toContain("api.syncStreamStop(");
    expect(src).toContain("platform.event.listen");
    expect(src).toContain('"sync-stream-change"');
    // ★ **顺序**：反了的话"起流那一刻"到达的帧会被丢掉（安静地少拉一次）
    const listenAt = src.indexOf("platform.event.listen");
    const startAt = src.indexOf("api.syncStreamStart(");
    expect(listenAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(listenAt, "必须**先挂监听**再起流").toBeLessThan(startAt);
    // 卸载要断开（不断开会留一条孤儿连接）
    expect(src).toContain("api.syncStreamStop()");
  });

  it("⑤ 桌面分支走**既有三件**：C2 闸门 / 防重入 / 状态行配对（不另写一套）", () => {
    expect(src).toContain("shouldAutoSyncNow()");
    expect(src).toContain("withSyncStatus(");
    expect(src).toContain("busy");
    expect(src).toContain("PULL_DEBOUNCE_MS");
  });

  it("⑥ ★ `ping` **不许当心跳忽略**：它要立刻拉一次（服务端落后时发的就是它）", () => {
    const at = src.indexOf('"ping"');
    expect(at, "认不出 ping 这个分支 ⇒ 落后时静默不更新").toBeGreaterThan(-1);
    // 精确到位（不用固定字数的窗口 —— 那会把后面的去抖代码也框进来，第一版就是这么误报的）：
    // **ping 之后的第一次 `pullOnce` 必须早于其后第一次 `setTimeout`** ⇒ 它就是"立刻拉"，不经去抖。
    const pullAfterPing = src.indexOf("pullOnce(", at);
    const timeoutAfterPing = src.indexOf("setTimeout(", at);
    expect(pullAfterPing, "ping 那条路上没有 pullOnce").toBeGreaterThan(-1);
    expect(
      timeoutAfterPing === -1 || pullAfterPing < timeoutAfterPing,
      "ping 那条路要「立刻」，不许先经过去抖",
    ).toBe(true);
  });

  it("⑦ 开关（默认开）**两处共用一处实现**：起停走 `applyNearRealtime`", () => {
    expect(nearRealtime).toContain("applyNearRealtime");
    expect(nearRealtime).toContain("api.syncStreamStop()");
    expect(nearRealtime).toContain("api.syncStreamStart(");
    // 默认值：只有显式存 "0" 才算关（读不到 ⇒ 开）
    expect(nearRealtime).toContain('!== "0"');
    // hook 也读同一个开关（关掉 ⇒ 什么都不做，与今天逐字相同）
    expect(src).toContain("isNearRealtimeEnabled()");
  });

  it("⑧ 流通道**不碰轮询**：它不拥有定时器、也不去关别人的（判据 7 的「不影响轮询」那一半）", () => {
    // "不影响轮询"在本仓是**结构性**的：两条路互不引用，轮询**无条件**挂在 App 上。
    // 这条判据钉的就是那个结构 —— 一旦有人给流通道塞一个定时器、或让"开近实时"变成"停轮询"，
    // 它就红（那时"流断了 ⇒ 什么都不更新"会安静地回来）。
    expect(src, "`useSyncStream` 自己起了定时器 ⇒ 两条路开始互相影响").not.toContain("setInterval(");
    expect(src, "`useSyncStream` 去关别人的定时器 ⇒ 轮询会被流通道影响").not.toContain("clearInterval(");
    // ⚠️ 2026-09-26 口径收敛：轮询那条路**从 hook 收回了 App 里那一段**（原来 `useAutoSync` 自带一条
    //   固定 5 分钟、走老全局配置的循环，与"按面板间隔、按每空间档案"那条并行 ⇒ 合成一条）。
    //    这条判据守的**还是那件事**：轮询必须是**无条件**挂上的，不能因为开了近实时就不挂。
    expect(app, "轮询必须**无条件**挂在 App 上（不是「开近实时就不轮询」）").toContain(
      'localStorage.getItem("shuyonote:autoSync")',
    );
    expect(app, "轮询必须**无条件**挂在 App 上（启动后先跑一次，与间隔设没设无关）").toContain(
      "setTimeout(tick, 3000)",
    );
    expect(src, "流通道不该引用轮询那条路（引用就会出现「谁关谁」的分支）").not.toContain("useAutoSync");
    expect(app, "那条独立的 5 分钟循环必须已经删掉（两套间隔 = 两份语义）").not.toContain("useAutoSync()");
    expect(app, "流通道也是无条件的（开关在 hook 内部读，不是在 App 里加条件）").toContain("useSyncStream();");
  });
});
