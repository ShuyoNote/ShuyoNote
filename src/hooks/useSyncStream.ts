// P1.5 SSE change-stream subscription (optional near-realtime push).
//
// 两条路，**同一个目的**（"远端有变更 ⇒ 立刻拉一次"），走的是两套平台事实：
//   · **Web**：浏览器自带 SSE ⇒ 这里直接 `fetch` + `ReadableStream` 读（`EventSource` 不能带
//     Bearer 头，所以手写读流）；每帧触发一次"拉一次"。
//   · **桌面**：WebView 里没有"能带鉴权的 SSE"，且桌面同步在 Rust 里 ⇒ 由 Rust 订流
//     （`sync_stream_start`，`src-tauri/src/sync_stream.rs`），**只发一个事件**（"有变更"），
//     **拉取仍由前端发起** —— 这样自动经过 C2 Wi-Fi 闸门 / 防重入 / 状态行这三件既有件
//     （设计稿 §3 形态 B 的唯一理由）。桌面**没有**流时退回轮询（`useAutoSync`），行为与今天一致。
//
// ⚠️ 第 45 轮修：Web 侧订的是**当前工作空间**那条绑定，不是"第一个绑定过的档案"
//    （多工作空间下会**订到别的空间**）—— 与 claim 那条"把本地工作空间 id 当远端 space_id 发"
//    是**同一类**错（挑错档案）。解析复用 `crdt/claimScope.ts` 的**唯一一处** `resolveWorkspaceSyncScope`。
//
// ⚠️ 第 48 轮加：桌面流通道。**`ping` 不是心跳** —— 服务端在订阅者落后（broadcast 容量 64）时发的
//    就是它 ⇒ 意味着"可能漏了事件" ⇒ **立刻拉一次**，与收到 `push` 同待遇（对 ping 不做去抖）。
import { useEffect } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { platform, isDesktopPlatform } from "../lib/platform";
import { resolveWorkspaceSyncScope, type ClaimScopeRow } from "../lib/crdt/claimScope";
import { isNearRealtimeEnabled } from "../lib/nearRealtime";
import { shouldAutoSyncNow } from "../lib/syncGate";
import { withSyncStatus } from "../store/syncStatus";

/** 桌面侧"收到帧 ⇒ 去抖 ⇒ 拉一次"的窗口（一次 push 可能连发多帧，不去抖就是突发）。 */
const PULL_DEBOUNCE_MS = 300;

/** 桌面 Rust 发上来的事件名（`src-tauri/src/sync_stream.rs` 里 `app.emit` 的那个）。 */
const STREAM_EVENT = "sync-stream-change";

export function useSyncStream() {
  const { loadPages } = useNotes();

  useEffect(() => {
    // 开关（默认开）：关掉 ⇒ 什么都不做，**与今天逐字相同**（纯轮询）。
    if (!isNearRealtimeEnabled()) {
      if (isDesktopPlatform()) void api.syncStreamStop().catch(() => null);
      return;
    }

    let cancelled = false;
    let ctrl: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | null = null;
    // 防重入：上一次"流触发的拉取"还没结束就跳过（与 `useAutoSync` 的 `syncing` 同一纪律）
    let busy = false;

    /** ★ **拉一次**：闸门 → 状态行配对 → 刷新列表。两条平台路共用它（一处实现）。 */
    const pullOnce = async (wsId: string) => {
      if (busy || cancelled) return;
      // C2 网络闸门（**一处实现**在 `lib/syncGate.ts`）：开了"只在 Wi-Fi 下自动同步"时非 Wi-Fi 不拉。
      // 流触发也属于**自动**同步 ⇒ 必须过闸（手动点「同步」不走这里）。
      if (!(await shouldAutoSyncNow())) return;
      if (cancelled) return;
      busy = true;
      try {
        // P1：自动同步**必须配对 begin/end**（`withSyncStatus`），否则面板会永远停在"正在同步…"。
        await withSyncStatus("正在同步…", () => api.syncWorkspace(wsId));
        if (!cancelled) await loadPages();
      } catch (e) {
        // 流触发的拉取失败**不静默**：留痕，等下一次事件/轮询再试（不打断用户）。
        console.error("[sync] 变更流触发的同步失败", e);
      } finally {
        busy = false;
      }
    };

    if (isDesktopPlatform()) {
      // ── 桌面：Rust 订流 ＋ 事件 ⇒ 拉一次 ──────────────────────────────────────────────
      (async () => {
        try {
          const wsId = await api.getActiveWorkspaceId();
          if (!wsId || cancelled) return;
          // ⚠️ **顺序有讲究**：先挂监听、再起流。反了的话"起流那一刻"到达的帧会被丢掉。
          unlisten = await platform.event.listen<{ ws_id?: string; kind?: string }>(STREAM_EVENT, (e) => {
            const kind = e?.payload?.kind ?? "other";
            // `ping` ＝ 服务端说"你落后了、可能漏了事件" ⇒ **立刻拉**，不去抖。
            if (kind === "ping") {
              void pullOnce(wsId);
              return;
            }
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => void pullOnce(wsId), PULL_DEBOUNCE_MS);
          });
          if (cancelled) {
            unlisten?.();
            unlisten = null;
            return;
          }
          const st = await api.syncStreamStart(wsId);
          if (!cancelled && !st?.running) {
            // 正常情况（没绑服务器/没选空间）**不是错误**，但要如实说清为什么没有近实时。
            console.info(`[sync] 近实时未启用（${st?.reason || st?.last_error || "unknown"}）⇒ 退回轮询`);
          }
        } catch (e) {
          // 起流失败**不抛给界面**（第 38 轮那条教训：正常情况不许抛）；退回轮询。
          console.warn("[sync] 变更流启动失败 ⇒ 退回轮询", e);
        }
      })();

      return () => {
        cancelled = true;
        if (debounce) clearTimeout(debounce);
        unlisten?.();
        // 卸载就断开（切工作空间/关面板/退出登录都由它兜底；不断开会留一条孤儿连接）。
        void api.syncStreamStop().catch(() => null);
      };
    }

    // ── Web：浏览器自带 SSE，这里手写读流 ────────────────────────────────────────────────
    (async () => {
      try {
        const wsId = await api.getActiveWorkspaceId();
        const profiles = await api.listSyncProfiles();
        // ⚠️ 解析结果为空（没绑定／没选空间）⇒ **什么都不做**（退回轮询），不是错误。
        const scope = resolveWorkspaceSyncScope(profiles as ClaimScopeRow[], wsId);
        if (!scope) return;
        const url = `${scope.server}/spaces/${encodeURIComponent(scope.spaceId)}/changes-stream`;
        ctrl = new AbortController();
        // ⚠️ 令牌用**档案里那份**（与旧行为一致）：会话表里那份更"新"，但这一层拿不到它
        //    （`getAuthSession` 在平台层内部）—— 令牌过期时这段会 401，然后**安静退回轮询**。
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${scope.token}` }, signal: ctrl.signal });
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // Read SSE frames (data: <json>\n\n); on each, trigger a pull.
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled || done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.includes("data:")) continue;
            // ★ 同步的是**当前工作空间**（解析出来那一个），不是"档案里第一个"；
            //   与桌面同一套：闸门 ＋ 状态行配对 ＋ 刷新（`pullOnce` 一处实现）。
            void pullOnce(wsId);
          }
        }
      } catch {
        /* stream best-effort; falls back to poll */
      }
    })();

    return () => {
      cancelled = true;
      ctrl?.abort();
    };
  }, [loadPages]);
}
