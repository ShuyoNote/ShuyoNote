// 「发布到社区」——三段式：**未连接 / 已连接 / 发布前清单（I7）** ＋ 结果分支。
//
// 这一屏把既有方案的底线条款落成一个能点的东西
// （`docs/plans/2026-09-11-app-community-interactions.md` §一：
//  "任何『自动上传』默认关闭；上传前必须给出清单，并由人手动确认"）：
//   · 打开对话框**只做两条只读查询**：`community_connection`（问一句"连上了没有"）＋
//     `community_publish_state`（问一句"这篇发过没有、发的是哪一版"）；两条都是纯本地只读，
//     **不发帖、不抓设备码、不上传**；
//   · 清单里摆出**将要发出去的东西**：标题、标签、正文全文（整篇，带字数）、图片张数
//     （owner 2026-09-20 拍板：发整篇正文，靠"清单 + 人确认"守底线，不做默认截断）；
//   · **人点「确认发布」才调 `community_upload_attachment` / `community_publish_note`**——
//     没有定时、没有"顺手同步"、没有"上次发过就自动再发"；
//   · 结果按 `status` 分支（不是按 HTTP 码），因为 `status` 说的是"用户该做什么"。
//
// 图片上传（本版接上）：正文里的**本地图片**先 `community_upload_attachment` 传到社区
// （内容寻址），正文里的引用换成社区给的 `/attachments/<hash>` 再发帖。
//   · **没上传成功就不许发帖**：任何一张失败 ⇒ 立刻停，且错误里点出是**哪一张**（带 hash）；
//   · 传不上去的（视频/没有指纹的本机图）**在清单里如实说**——静默缺图比报错更伤人；
//   · 清单与发帖**同一份来源**：正文只从 `docJson` 算，不在 props 里再塞一份 body
//     （"清单里一份、发出去另一份"是这一屏最容易出的缝）。
//
// 幂等（I2）：`(noteId, rev)` 由调用方传进来，**幂等键由后端算**（`community_publish.rs`），
// 前端不自己造 key —— 两侧各算一份迟早漂成两种口径。所以本组件只负责**原样把它们递下去**。
//
// 发布台账（本版接上）：后端在**发布成功时自己回写**一行"这篇最近发到哪儿、发的是哪一版"
// （`community_publish_note` 内部，见 `community_publish.rs` 的 `record_into_db`），前端**只读不写**。
// 这一屏据此说清三件事（拿 `publishedRev` 与当前 `rev` 比）：
//   · 没台账（`null`）⇒ 一句中性的"还没发过"，**不吓唬人**；
//   · 同 rev ⇒ 这一版已经发过，**再发一次不会多发一篇**（同一个幂等键回放首次结果）；
//   · 不同 rev ⇒ 上次发布的是更早的一版，**再发会新建一篇**（本版还不更新已有帖子，P2 才做）。
// 读台账**失败不挡界面**：它只是一句提示，读不到就等于没有 —— 但也不假装"没发过"
// （那是替用户断言一件我们并不知道的事），所以把理由记在 `ledgerError` 里，用一句中性的话说明。
//
// 令牌（I3）：**永远不进这个组件的 state**。`community_connection` 回的形状里本来就没有令牌
// 字段（只有 `{base, username, scope, savedAt}`），令牌留在应用数据目录里，这一层连它的形状都不知道。
//
// 定时器：轮询由**界面自己驱动**（后端不挂定时任务，见 `community_publish.rs:574` 的注释），
// 所有 interval 都登记在 `pollTimer` / `tickTimer` 里，**卸载（= 关闭对话框）时全停**。
import { useEffect, useMemo, useRef, useState } from "react";
import { platform } from "../lib/platform";
import type {
  CommunityConnectState,
  CommunityConnection,
  CommunityDeviceStart,
  CommunityPublishResult,
  CommunityPublishState,
  CommunityUploadedAttachment,
} from "../lib/platform/commands";
import { pageContentToMarkdown, pageImageRefs } from "../lib/exportMarkdown";
import { sanitizeExternalUrl } from "../lib/links";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

export interface CommunityPublishDialogProps {
  /** 笔记标题（清单里原样展示，也是发给社区的 `title`）。 */
  title: string;
  /**
   * 正文的**唯一来源**：页面文档 JSON 的一次快照（Markdown 由本组件自己算）。
   *
   * 为什么收 `docJson` 而不是收算好的 `body`：清单里展示的正文、上传后发出去的正文
   * 必须是同一份。让调用方传 body、组件再自己拼一份"换了地址的 body"，等于同一条正文
   * 有两条来路——迟早出现"清单里是 A、发出去是 B"。
   */
  docJson: string;
  tags: string[];
  /** 笔记 id。与 `rev` 一起算幂等键，取值必须稳定（见 `EditorToolbar` 里的注释）。 */
  noteId: string;
  /** 修订号。**同一个 (noteId, rev) 必须永远算出同一个键**，否则"重试一次多一篇"。 */
  rev: string;
  onClose: () => void;
}

/** 设备码流程：`idle` 还没开始 / `starting` 正在要码 / `waiting` 等人在浏览器里确认 / `stopped` 结束。 */
type ConnectFlow = "idle" | "starting" | "waiting" | "stopped";

/** Markdown 图片语法：`![alt](src)`（src 到第一个 `)`/空白为止，可被 `<>` 包着）。 */
const IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)/g;

/** 正文里有几张图（含社区地址的、远程的 —— 这是"这篇长什么样"，不是"要传几张"）。 */
function countImages(md: string): number {
  let n = 0;
  for (const _ of md.matchAll(IMAGE_RE)) n += 1;
  return n;
}

/**
 * **已把所有带指纹的图片换成社区地址之后**，还剩几张社区取不到的。
 *
 * 为什么要这一步：没有 `__hash` 的 ImageNode（比如从 Markdown 导进来的 `attachment://…`）
 * 传不上去（上传命令只认 hash），发出去就是一张空图。上一版对这类图是明说的
 * （"本版不做图片上传"），接上上传之后**不能反而变得沉默**。
 */
function unreachableImages(md: string): number {
  let n = 0;
  for (const m of md.matchAll(IMAGE_RE)) {
    const src = m[1];
    const reachable = /^https?:\/\//i.test(src) || src.startsWith("/attachments/") || src.startsWith("data:");
    if (!reachable) n += 1;
  }
  return n;
}

/**
 * 清单与发帖共用的那一份正文（**一次算好，两处都从这里取**）。
 *
 * `body`：清单里摆出来的全文（本地引用原样可见 —— 人看到的正是"上传前"的样子）；
 * `broken`：假设每张有指纹的图都传成功，还剩几张是社区取不到的（见 `unreachableImages`）。
 */
function prepareContent(docJson: string): { body: string; broken: number; error: string } {
  try {
    const body = pageContentToMarkdown(docJson);
    // 用一个**只换地址、不碰别的**的假映射，问出"上传成功之后还剩几张破图"。
    const resolved = pageContentToMarkdown(docJson, (hash) => `/attachments/${hash}`);
    return { body, broken: unreachableImages(resolved), error: "" };
  } catch (e) {
    // 解析不了 ⇒ 说清、且**不许发**（发一份自己都不认识的正文比报错更糟）。
    return { body: "", broken: 0, error: `正文解析失败，先别发：${e instanceof Error ? e.message : String(e)}` };
  }
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

export function CommunityPublishDialog({ title, docJson, tags, noteId, rev, onClose }: CommunityPublishDialogProps) {
  useOverlayScrollLock(true);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("communityPublish", true, onClose);

  /**
   * 清单正文与"有哪些图要传"都从 `docJson` 算（`docJson` 不变就不重算）。
   * `imageRefs` 里的每一张**都会先上传**（只有 `kind === "image"` 的能传，视频传不上去）。
   */
  const prepared = useMemo(() => prepareContent(docJson), [docJson]);
  const refs = useMemo(() => pageImageRefs(docJson), [docJson]);
  /** 只有图片能传（`community_upload_attachment` 的社区白名单里没有视频）。 */
  const imageRefs = useMemo(() => refs.filter((r) => r.kind === "image"), [refs]);
  const videoCount = refs.length - imageRefs.length;

  /** `undefined` = 还没问过（读取中）；`null` = 问过了、没连上。 */
  const [connection, setConnection] = useState<CommunityConnection | null | undefined>(undefined);
  const [connError, setConnError] = useState("");
  /**
   * 发布台账：`undefined` = 读取中；`null` = 读到了、这篇没发过。
   * `ledgerError` 非空时**两样都不显示**（读都没读到，任何结论都是编的），只说明"这次没读到"。
   */
  const [ledger, setLedger] = useState<CommunityPublishState | null | undefined>(undefined);
  const [ledgerError, setLedgerError] = useState("");
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
  /** 上传是慢操作：静默会像卡死，所以"正在上传第 i/N 张…"要看得见。 */
  const [uploadNote, setUploadNote] = useState("");
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

  /**
   * 读一次**发布台账**（`community_publish_state`：只读、纯本地，不碰网络、不带令牌）。
   *
   * 失败**不挡界面**：台账只是"这篇发过没有"的一句提示，读不到不该让对话框打不开
   * （`web.ts` 就是这么处理的：没有本地库 ⇒ 回 `null`，而不是抛错）。但也不能
   * "读不到就当成没发过" —— 那是在替用户断言一件我们并不知道的事，他可能因此
   * 再发一篇。所以：`ledger` 落成 `null` 表示"没有可显示的三态"，理由进 `ledgerError`，
   * 界面用**中性**的话说明"这次没读到"（不是红字错误，它不影响发布）。
   */
  const loadPublishState = async (): Promise<void> => {
    try {
      const s = await platform.executor.invoke<CommunityPublishState | null>("community_publish_state", {
        pageId: noteId,
      });
      setLedger(s);
      setLedgerError("");
    } catch (e) {
      setLedger(null);
      setLedgerError(e instanceof Error ? e.message : String(e));
    }
  };

  // 打开对话框**只做这两条只读查询**：①"连上了没有" ②"这篇发过没有、发的哪一版"。
  // 发帖、抓设备码、上传图片都不在这一步（I7）。
  useEffect(() => {
    void loadConnection();
    void loadPublishState();
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

  /**
   * **只有人点了「确认发布」才会走到这里。** 顺序是死的：
   *   ① 逐张上传本地图片（按 hash 去重，只传 `kind === "image"`）→
   *   ② 用社区回的 `url` 建 `hash → url` 映射 →
   *   ③ 用映射把正文里的本地引用换成社区地址 →
   *   ④ 发帖（发出去的 body 就是第 ③ 步那一份）。
   *
   * **①/②/③ 任何一步失败都立刻停、不发帖**（I4：错在哪一步就说哪一步）——
   * "上传失败"绝不能报成"发布失败"：那会让人去重试发帖，而真正该修的是那张图。
   */
  const publish = async () => {
    setSending(true);
    setSendError("");
    setUploadNote("");
    try {
      // ① 上传。`imageRefs` 已按 hash 去重（见 `pageImageRefs`），同一张图只传一次。
      /** hash（本机）→ 社区地址。img 节点的 `__hash` 就是本机 hash。 */
      const uploaded = new Map<string, string>();
      const total = imageRefs.length;
      for (let i = 0; i < total; i++) {
        const ref = imageRefs[i];
        setUploadNote(`正在上传第 ${i + 1}/${total} 张…`);
        let up: CommunityUploadedAttachment;
        try {
          up = await platform.executor.invoke<CommunityUploadedAttachment>("community_upload_attachment", {
            hash: ref.hash,
          });
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          throw new Error(`第 ${i + 1}/${total} 张图片上传失败（附件 ${ref.hash}）：${why}`);
        }
        // ② 社区没给地址就换不了引用 ⇒ 当成失败停下：宁可让人重试，也不要发一篇地址是空/
        //    本机协议的文章出去（那在社区上就是一张破图）。
        if (!up || !up.url) {
          throw new Error(`第 ${i + 1}/${total} 张图片上传后社区没给地址（附件 ${ref.hash}）：拒绝继续发布。`);
        }
        uploaded.set(ref.hash, up.url);
      }
      setUploadNote("");

      // ③ 换地址：只换"有指纹且映射里有"的那些，其余保持 `__src`（与清单里看到的一致）。
      const body = pageContentToMarkdown(docJson, (hash) => uploaded.get(hash) ?? "");

      // ④ 发帖：`body` 就是第 ③ 步那一份。
      const r = await platform.executor.invoke<CommunityPublishResult>("community_publish_note", {
        title,
        body,
        tags,
        noteId,
        rev,
      });
      setResult(r);
      if (r.status === "ok") {
        // 后端在发布成功时已经把台账回写成这一版；这里**重读一次**，让界面立刻反映
        // "刚发的是这一版"（否则还停在打开那一刻的旧结论上，甚至说"还没发过"）。
        await loadPublishState();
      }
      if (r.status === "unauthorized") {
        // 令牌失效/被撤销：后端的本地凭据已经删了，界面回到"连接社区"。
        setConnection(null);
        setApprovedName("");
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setUploadNote("");
    }
  };

  // 「已连接」看的是后端存着凭据（`connection`），`approvedName` 只是刚批准那一瞬的兜底：
  // `community_connection` 第二次读回来慢一点，也不该把"已连接"闪回"未连接"。
  const connected = connection != null || approvedName !== "";
  const who = connection?.username || approvedName;
  const body = prepared.body;
  const chars = body.length;
  const imgs = countImages(body);

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
          {/* 正文解析不了 ⇒ 清单本身就是假的，先说出来（发布按钮也据此禁用）。 */}
          {prepared.error && <div className="community-save-error">{prepared.error}</div>}
          {/* 上传是慢操作：这一句就是"它还活着"的证据。 */}
          {uploadNote && <div className="community-save-more">{uploadNote}</div>}
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

              {/* ---- 发布台账（只读）：这篇发过没有、发的是哪一版、再发一次会怎样 ----
                  放在"发布前清单"**上方**：先让人知道"这篇的处境"，再看"将要发什么"。
                  三个状态互斥，且都只在**已连接**时显示（未连接时发布根本还没开始谈）。 */}
              {ledgerError !== "" && (
                <div className="community-save-more">
                  这次没读到发布台账（{ledgerError}）—— 不影响发布，只是这次不显示"这篇发过没有"。
                </div>
              )}
              {ledgerError === "" && ledger === null && (
                <div className="community-save-preview-meta">发布台账：这篇还没发过。</div>
              )}
              {ledgerError === "" && ledger != null && ledger.publishedRev === rev && (
                <div className="community-save-preview" data-ledger="same-rev">
                  <div className="community-save-preview-meta">
                    发布台账：这一版已经发过（修订 {ledger.publishedRev}）。
                  </div>
                  <button
                    className="community-save-source"
                    onClick={() => void openExternal(ledger.url)}
                    title="在浏览器里打开已发布的这一篇"
                  >
                    {ledger.url}
                  </button>
                  <div className="community-save-preview-meta">
                    现在再发一次不会多发一篇：社区按同一个幂等键回放第一次的结果。
                  </div>
                </div>
              )}
              {ledgerError === "" && ledger != null && ledger.publishedRev !== rev && (
                <div className="community-save-preview" data-ledger="older-rev">
                  <div className="community-save-preview-meta">
                    发布台账：上次发布的是更早的一版（发出去的是修订 {ledger.publishedRev}，当前是 {rev}）。
                  </div>
                  <button
                    className="community-save-source"
                    onClick={() => void openExternal(ledger.url)}
                    title="在浏览器里打开上次发布的那一篇"
                  >
                    {ledger.url}
                  </button>
                  <div className="community-save-preview-meta">
                    当前这一版与上次发出去的那一版**不是同一个修订**，所以现在再发会新建一篇
                    （这一版不会更新已发布的帖子，更新是 P2 才做的）。
                  </div>
                  {/* 只说"不是同一个修订"，不说"内容改过了"：`rev` 取自页面 `updated_at`，
                      "改一个字再改回去"也会换修订，而内容其实一模一样 —— 那会是一句我们并不知道的结论。 */}
                  <div className="community-save-more">
                    修订号取自页面的更新时间，不是内容指纹：改了又改回去也会算新修订。
                  </div>
                </div>
              )}

              {result === null && (
                <div className="community-save-preview">
                  <div className="community-save-preview-title">发布前清单：下面这些会发到社区</div>
                  <div className="community-save-preview-meta">
                    标题：{title || "（这篇没有标题——社区会拒绝，先给笔记起个名）"}
                  </div>
                  <div className="community-save-preview-meta">
                    标签：{tags.length > 0 ? tags.map((t) => `#${t}`).join(" ") : "（没有标签）"}
                  </div>
                  <div className="community-save-preview-meta">
                    正文：整篇全文 {chars} 字 · 图片 {imgs} 张
                  </div>
                  {/* 清单要说的不是"有几张图"，而是"点了确认之后会发生什么"：
                      下面这 N 张**会先上传**，正文里它们的地址会变成社区地址。 */}
                  {imageRefs.length > 0 && (
                    <div className="community-save-more">
                      图片 {imageRefs.length} 张会先上传到社区，正文里的引用会换成 /attachments/&lt;hash&gt;。（上传没成功就不会发帖。）
                    </div>
                  )}
                  {/* 传不上去的要如实说 —— 白名单只有 png/jpeg/gif/webp/pdf/zip（按魔数判），视频不在其中。 */}
                  {videoCount > 0 && (
                    <div className="community-save-error">
                      视频 {videoCount} 个发不出去（社区附件白名单不含视频），发出去会缺。
                    </div>
                  )}
                  {/* 没有附件指纹（`__hash` 为空）的本机图同样传不上去：不静默。 */}
                  {prepared.broken > 0 && (
                    <div className="community-save-error">
                      还有 {prepared.broken} 张图没有附件指纹（本机图片但缺 hash），传不上去：发出去会缺。
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
          {/* 「确认发布」与清单同生共死：没有清单就没有这个按钮（I7）。
              正文解析不了（`prepared.error`）时禁用：没有可信的清单就没有可发的正文。 */}
          {connected && (result === null || result.status === "inFlight") && (
            <button
              className="community-save-btn primary"
              disabled={sending || prepared.error !== ""}
              onClick={() => void publish()}
            >
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
