// 「发布到社区」——三段式：**未连接 / 已连接 / 发布前清单（I7）** ＋ 结果分支。
//
// 这一屏把既有方案的底线条款落成一个能点的东西
// （`docs/plans/2026-09-11-app-community-interactions.md` §一：
//  "任何『自动上传』默认关闭；上传前必须给出清单，并由人手动确认"）：
//   · 打开对话框**只调一次 `community_connection`**（问一句"连上了没有"）；
//     不抓取、不预上传、不发帖；
//   · 清单里摆出**将要发出去的东西**：标题、标签、正文全文（整篇，带字数）、图片张数
//     （owner 2026-09-20 拍板：发整篇正文，靠"清单 + 人确认"守底线，不做默认截断）；
//   · **人点「确认发布」才调 `community_publish_note`**——没有定时、没有"顺手同步"、
//     没有"上次发过就自动再发"；
//   · 结果按 `status` 分支（不是按 HTTP 码），因为 `status` 说的是"用户该做什么"。
//
// 幂等（I2）：`(noteId, rev)` 由调用方传进来，**幂等键由后端算**（`community_publish.rs`），
// 前端不自己造 key —— 两侧各算一份迟早漂成两种口径。所以本组件只负责**原样把它们递下去**。
//
// 令牌（I3）：**永远不进这个组件的 state**。`community_connection` 回的形状里本来就没有令牌
// 字段（只有 `{base, username, scope, savedAt}`），令牌留在应用数据目录里，这一层连它的形状都不知道。
//
// 定时器：轮询由**界面自己驱动**（后端不挂定时任务，见 `community_publish.rs:574` 的注释），
// 所有 interval 都登记在 `pollTimer` / `tickTimer` 里，**卸载（= 关闭对话框）时全停**。
import { useEffect, useRef, useState } from "react";
import { platform } from "../lib/platform";
import type {
  CommunityConnectState,
  CommunityConnection,
  CommunityDeviceStart,
  CommunityPublishResult,
} from "../lib/platform/commands";
import { sanitizeExternalUrl } from "../lib/links";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

export interface CommunityPublishDialogProps {
  /** 笔记标题（清单里原样展示，也是发给社区的 `title`）。 */
  title: string;
  /** 正文 Markdown —— **整篇全文**（清单里也展示全文，不做截断）。 */
  body: string;
  tags: string[];
  /** 笔记 id。与 `rev` 一起算幂等键，取值必须稳定（见 `EditorToolbar` 里的注释）。 */
  noteId: string;
  /** 修订号。**同一个 (noteId, rev) 必须永远算出同一个键**，否则"重试一次多一篇"。 */
  rev: string;
  onClose: () => void;
}

/** 设备码流程：`idle` 还没开始 / `starting` 正在要码 / `waiting` 等人在浏览器里确认 / `stopped` 结束。 */
type ConnectFlow = "idle" | "starting" | "waiting" | "stopped";

/**
 * Markdown 里的图片：`![alt](src)`。
 *
 * 为什么要数它：社区侧有 `POST /api/attachments`（内容寻址），本地图片要先传上去换成
 * `/attachments/<hash>` 再发——**本版不做图片上传**（方案 P0 的剩余项）。所以清单必须
 * 把"正文里有几张本地图、它们发出去会怎样"如实说出来，而不是让人发完才发现图没了。
 */
function imagesIn(body: string): { total: number; local: number } {
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
  let total = 0;
  let local = 0;
  for (const m of body.matchAll(re)) {
    total += 1;
    // `attachment://…` 是桌面端的应用专有协议，相对路径/裸路径同理：都不是社区能取到的地址。
    if (!/^https?:\/\//i.test(m[1])) local += 1;
  }
  return { total, local };
}

/** 非 `pending`/`approved` 的状态：如实说清是哪一个，并允许重开一次。 */
function connectStateNote(state: CommunityConnectState): string {
  if (state === "expired") return "设备码已过期（没人在确认页上确认）。可以重新开始一次。";
  if (state === "already_used") return "这个设备码已经被用过了。可以重新开始一次。";
  if (state === "unknown") return "社区不认识这个设备码（可能已过期或被清掉）。可以重新开始一次。";
  if (state.startsWith("failed_")) {
    return `社区返回了失败状态 ${state}（后缀是 HTTP 状态码）。可以重新开始一次。`;
  }
  return `社区返回了没预期到的状态：${state}。可以重新开始一次。`;
}

export function CommunityPublishDialog({ title, body, tags, noteId, rev, onClose }: CommunityPublishDialogProps) {
  useOverlayScrollLock(true);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("communityPublish", true, onClose);

  /** `undefined` = 还没问过（读取中）；`null` = 问过了、没连上。 */
  const [connection, setConnection] = useState<CommunityConnection | null | undefined>(undefined);
  const [connError, setConnError] = useState("");
  /** `approved` 那一刻社区给的用户名：只用来显示"已连接：<谁>"。 */
  const [approvedName, setApprovedName] = useState("");

  const [device, setDevice] = useState<CommunityDeviceStart | null>(null);
  const [flow, setFlow] = useState<ConnectFlow>("idle");
  const [flowNote, setFlowNote] = useState("");
  const [remaining, setRemaining] = useState(0);
  const expiresAt = useRef(0);

  const [disconnecting, setDisconnecting] = useState(false);
  /**
   * `community_disconnect` 回来的结果：`note` **原样展示**。
   * `remoteRevoked === false` 时那句话要说的是"本地删了、远端那把令牌可能还有效"——
   * 那是**警告**，不是一句普通说明，所以按它选样式（`community-save-error`）。
   */
  const [disconnectOutcome, setDisconnectOutcome] = useState<{ remoteRevoked: boolean; note: string } | null>(null);

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<CommunityPublishResult | null>(null);
  const [sendError, setSendError] = useState("");

  const pollTimer = useRef<number | null>(null);
  const tickTimer = useRef<number | null>(null);

  const stopTimers = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (tickTimer.current !== null) {
      window.clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
  };

  // **关闭对话框 = 卸载组件 = 这里**：所有定时器一个不留。
  useEffect(() => stopTimers, []);

  const loadConnection = async (): Promise<CommunityConnection | null> => {
    try {
      const conn = await platform.executor.invoke<CommunityConnection | null>("community_connection");
      setConnection(conn);
      setConnError("");
      return conn;
    } catch (e) {
      setConnection(null);
      setConnError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  // 打开对话框**只问一句**"连上了没有"。发帖、抓取、上传图片都不在这一步。
  useEffect(() => {
    void loadConnection();
  }, []);

  const openExternal = async (raw: string) => {
    const safe = sanitizeExternalUrl(raw);
    if (!safe) return;
    try {
      await platform.opener.openUrl(safe);
    } catch {
      /* 浏览器被拦时安静失败：这只是一次"去看看" */
    }
  };

  /** 轮询一次。`pending` 继续等；`approved` 之后后端已把令牌存下来了。 */
  const pollOnce = async (deviceCode: string) => {
    let state: CommunityConnectState;
    let username: string | null = null;
    try {
      const r = await platform.executor.invoke<{ state: CommunityConnectState; username: string | null }>(
        "community_connect_poll",
        { deviceCode },
      );
      state = r.state;
      username = r.username;
    } catch (e) {
      stopTimers();
      setFlow("stopped");
      setFlowNote(`问社区的时候出错了：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (state === "pending") return;
    stopTimers();
    if (state === "approved") {
      // 令牌已经在后端落盘；这里再读一次"这是谁的授权"（组件始终拿不到令牌本身）。
      if (username) setApprovedName(username);
      setDevice(null);
      setFlow("idle");
      setFlowNote("");
      await loadConnection();
      return;
    }
    setFlow("stopped");
    setFlowNote(connectStateNote(state));
  };

  /** 起设备码流程：显示 `userCode` 给人抄，并按 `intervalSeconds` 轮询。 */
  const startConnect = async () => {
    stopTimers();
    setDevice(null);
    setFlow("starting");
    setFlowNote("");
    setConnError("");
    try {
      const d = await platform.executor.invoke<CommunityDeviceStart>("community_connect_start");
      setDevice(d);
      setRemaining(d.expiresInSeconds);
      expiresAt.current = Date.now() + d.expiresInSeconds * 1000;
      setFlow("waiting");
      // 倒计时：到点即停（不留一个永远转的 interval）。
      tickTimer.current = window.setInterval(() => {
        const left = Math.max(0, Math.round((expiresAt.current - Date.now()) / 1000));
        setRemaining(left);
        if (left <= 0) {
          stopTimers();
          setFlow("stopped");
          setFlowNote("设备码已过期。可以重新开始一次。");
        }
      }, 1000);
      // 轮询：`intervalSeconds` 是社区给的节奏（取整并兜底 1 秒，避免 0 → 忙循环）。
      pollTimer.current = window.setInterval(() => {
        void pollOnce(d.deviceCode);
      }, Math.max(1, d.intervalSeconds) * 1000);
    } catch (e) {
      setFlow("idle");
      setConnError(e instanceof Error ? e.message : String(e));
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    setConnError("");
    try {
      const r = await platform.executor.invoke<{ localCleared: boolean; remoteRevoked: boolean; note: string }>(
        "community_disconnect",
      );
      setConnection(null);
      setApprovedName("");
      setResult(null);
      setDisconnectOutcome({ remoteRevoked: r.remoteRevoked, note: r.note });
    } catch (e) {
      setConnError(e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  /** **只有人点了「确认发布」才会走到这里。** */
  const publish = async () => {
    setSending(true);
    setSendError("");
    try {
      const r = await platform.executor.invoke<CommunityPublishResult>("community_publish_note", {
        title,
        body,
        tags,
        noteId,
        rev,
      });
      setResult(r);
      if (r.status === "unauthorized") {
        // 令牌失效/被撤销：后端的本地凭据已经删了，界面回到"连接社区"。
        setConnection(null);
        setApprovedName("");
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // 「已连接」看的是后端存着凭据（`connection`），`approvedName` 只是刚批准那一瞬的兜底：
  // `community_connection` 第二次读回来慢一点，也不该把"已连接"闪回"未连接"。
  const connected = connection != null || approvedName !== "";
  const who = connection?.username || approvedName;
  const chars = body.length;
  const imgs = imagesIn(body);

  return (
    <div className="community-save-overlay" onClick={onClose}>
      {/* 样式复用 `CommunitySaveDialog` 的 `community-save-*` 那一套（同族浮层、同一套数值，
          本版不动 App.css）；`community-publish-box` 是给测试与后续样式用的语义钩子。 */}
      <div className="community-save-box community-publish-box" onClick={(e) => e.stopPropagation()}>
        <div className="community-save-head">
          <span>发布到社区</span>
          <button className="community-save-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="community-save-body">
          {connError && <div className="community-save-error">{connError}</div>}
          {sendError && <div className="community-save-error">{sendError}</div>}
          {/* 断开时的原话，**原样**：撤销失败时它写明了"那把令牌仍然有效"——这句必须让人看见，
              所以它不放在"已连接"那一块里（断开之后那块就不显示了）。 */}
          {disconnectOutcome && (
            <div className={disconnectOutcome.remoteRevoked ? "community-save-more" : "community-save-error"}>
              {disconnectOutcome.note}
            </div>
          )}

          {/* ---- 结果分支：按 status 分（它说的是"用户该做什么"，不是 HTTP 码）---- */}
          {result && (
            <div className="community-save-preview" data-status={result.status}>
              {result.status === "ok" && (
                <>
                  <div className="community-save-preview-title">已发布到社区</div>
                  <button
                    className="community-save-source"
                    onClick={() => void openExternal(result.url)}
                    title="在浏览器里打开这篇"
                  >
                    {result.url}
                  </button>
                  <div className="community-save-preview-meta">
                    同一修订（{noteId} · {rev}）再发一次不会多发一篇：社区按幂等键回放第一次的结果。
                  </div>
                </>
              )}
              {result.status === "inFlight" && (
                <div className="community-save-preview-meta">
                  上一个同修订的发布还在处理中（社区 409 duplicate_in_flight）——这不是失败，稍后重试即可。
                </div>
              )}
              {result.status === "rejected" && (
                <>
                  <div className="community-save-preview-title">社区没有通过这篇（审核拦下）</div>
                  {/* 原样展示社区给的理由，不翻译、不改写。 */}
                  <div className="community-save-error">{result.error}</div>
                </>
              )}
              {result.status === "unauthorized" && (
                <>
                  <div className="community-save-preview-title">授权已被撤销，需要重新连接</div>
                  <div className="community-save-preview-meta">
                    本地连接信息已清掉；在重新连接之前，发布不会再成功。
                  </div>
                </>
              )}
              {result.status === "outOfScope" && (
                <>
                  <div className="community-save-preview-title">这把授权不允许这个操作（403 app_token_scope）</div>
                  <div className="community-save-preview-meta">
                    这是客户端的问题（打到白名单之外的接口了），不是你的操作有误——请把这句话反馈给开发者。
                  </div>
                </>
              )}
              {result.status === "unexpected" && (
                <>
                  <div className="community-save-preview-title">
                    社区回了一个没预期到的响应（HTTP {result.httpStatus}）
                  </div>
                  <div className="community-save-preview-meta">{result.error}</div>
                </>
              )}
            </div>
          )}

          {/* ---- ① 未连接 ---- */}
          {!connected && (
            <>
              {connection === undefined && !approvedName && <div className="community-save-preview-meta">正在读取连接状态…</div>}
              {connection === null && !device && (
                <div className="community-save-preview-meta">
                  还没有连接社区。连接一次就能发布：不用输密码，在自己浏览器里确认一次即可
                  （换来的是一把只能发帖、随时可撤销的授权）。
                </div>
              )}
              {device && (
                <div className="community-save-preview">
                  <div className="community-save-preview-title">在浏览器里确认这次连接</div>
                  {/* 大字显示：这个码是要人**抄过去**的，别让人眯着眼找。 */}
                  <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2, margin: "8px 0" }}>
                    {device.userCode}
                  </div>
                  <div className="community-save-preview-meta">
                    {flow === "stopped"
                      ? flowNote
                      : `剩余有效期 ${remaining} 秒（每 ${Math.max(1, device.intervalSeconds)} 秒问一次社区）`}
                  </div>
                  <button
                    className="community-save-source"
                    onClick={() => void openExternal(device.verifyUrl)}
                    title="在浏览器里打开确认页"
                  >
                    打开确认页：{device.verifyUrl}
                  </button>
                </div>
              )}
            </>
          )}

          {/* ---- ② 已连接 ＋ ③ 发布前清单（I7）：清单只在"还没发"时出现 ---- */}
          {connected && (
            <>
              <div className="community-save-preview-meta">
                已连接：{who || "（社区没给出用户名）"}
                {connection?.base ? ` · ${connection.base}` : ""}
                {connection?.scope ? ` · 授权范围：${connection.scope}` : ""}
              </div>

              {result === null && (
                <div className="community-save-preview">
                  <div className="community-save-preview-title">发布前清单：下面这些会原样发到社区</div>
                  <div className="community-save-preview-meta">
                    标题：{title || "（这篇没有标题——社区会拒绝，先给笔记起个名）"}
                  </div>
                  <div className="community-save-preview-meta">
                    标签：{tags.length > 0 ? tags.map((t) => `#${t}`).join(" ") : "（没有标签）"}
                  </div>
                  <div className="community-save-preview-meta">
                    正文：整篇全文 {chars} 字 · 图片 {imgs.total} 张
                  </div>
                  {imgs.local > 0 && (
                    <div className="community-save-more">
                      其中 {imgs.local} 张是「本机图片」（正文里是 attachment://… 这种社区取不到的地址）。
                      本版不做图片上传：这 {imgs.local} 张发出去以后在社区上会显示不出来。图片上传是后续版本的事。
                    </div>
                  )}
                  {/* 正文**整篇**摆出来（owner 2026-09-20：发的就是整篇，不是摘要）。 */}
                  <div className="community-save-preview-body">{body || "（正文是空的）"}</div>
                  <div className="community-save-target">发布到：{connection?.base || "社区"}</div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="community-save-foot">
          {!connected && !device && (
            <button className="community-save-btn primary" disabled={flow === "starting"} onClick={() => void startConnect()}>
              {flow === "starting" ? "正在要设备码…" : "连接社区"}
            </button>
          )}
          {!connected && device && (
            <button className="community-save-btn" onClick={() => void startConnect()}>
              重新开始
            </button>
          )}
          {/* 「确认发布」与清单同生共死：没有清单就没有这个按钮（I7）。 */}
          {connected && (result === null || result.status === "inFlight") && (
            <button className="community-save-btn primary" disabled={sending} onClick={() => void publish()}>
              {sending ? "发布中…" : result?.status === "inFlight" ? "重试" : "确认发布"}
            </button>
          )}
          {connected && result !== null && result.status !== "inFlight" && (
            <button className="community-save-btn" onClick={() => setResult(null)}>
              返回清单
            </button>
          )}
          {connected && (
            <button className="community-save-btn" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? "断开中…" : "断开连接"}
            </button>
          )}
          <button className="community-save-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
