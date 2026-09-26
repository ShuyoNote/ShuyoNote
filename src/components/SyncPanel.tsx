import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { api, type SyncProfile, type SyncBudget, type LanStatus } from "../lib/api";
import { useSpaceStore } from "../store/space";
import { useAuth } from "../store/auth";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import { useSyncStatus } from "../store/syncStatus";
import { inputDialog } from "../store/input";
import { CloudSyncIcon } from "./icons";
import { isDesktopPlatform } from "../lib/platform";
import { isNearRealtimeEnabled, applyNearRealtime } from "../lib/nearRealtime";
import {
  readAutoSyncMs,
  settingsForMode,
  syncModeHint,
  syncModeOf,
  writeAutoSyncMs,
  type SyncMode,
} from "../lib/syncMode";
import { SpacePrivacySection } from "./SpacePrivacySection";

const ENTITY_LABELS: Record<string, string> = {
  page: "页面",
  database: "数据库",
  attachment: "附件",
  block: "块",
};
const entityLabel = (e: string) => ENTITY_LABELS[e] || e || "项";
// 相对时间：最近用「刚刚/几秒前/几分钟前」，超过 1 天显示日期。
const relTime = (ts: number) => {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDuration = (ms: number) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " 秒";
/** C1：本次下载量说成人话（只用来展示，精度不重要）。 */
const fmtMb = (bytes: number) => {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

interface ServerSpace {
  id: string;
  name: string;
  role: string;
  owner_id: string;
}

interface ServerMember {
  user_id: string;
  email: string;
  role: string;
}

interface EditRow {
  ws_id: string;
  name: string;
  server_url: string;
  token: string;
  space_id: string;
  // Login-to-get-token (U3): email/password are transient (never persisted); the
  // resulting token fills `token`. `remoteSpaces` caches the spaces the account
  // joined (from GET /spaces) so the 空间 ID 可以下拉绑定.
  loginEmail: string;
  loginPassword: string;
  // 注册邀请码（仅注册 tab 用，注册时传给服务端 /auth/register）。
  loginRegisterCode: string;
  // 登录/注册 tab（login | register）。
  authMode: "login" | "register";
  remoteSpaces: ServerSpace[];
  // M27 成员管理（选中空间且已登录后可用）：members 列表 + 邀请表单。
  members: ServerMember[];
  memberOpen: boolean;
  inviteEmail: string;
  inviteRole: string;
  // P6.1 每空间「附件同步」开关（默认 true）。**只控制附件字节**，笔记正文 / 标题 /
  // 结构等元数据照常同步 ⇒ 关掉后另一端「看得见但打不开」。
  syncAttachments: boolean;
}

// Per-workspace sync targets (S8): each local workspace binds to its own remote
// (server + token + space_id), so one person can sync different spaces to
// different servers/accounts (multi-server × multi-space).
export function SyncPanel() {
  // 面板比默认弹层宽/高，把实际尺寸告诉 usePopover，靠边打开时才不会被切掉。
  const { open, pos, isSheet, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>({
    width: 452,
    minSpace: 420,
  });
  useOverlayScrollLock(open);
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("sync", open, () => close());
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const authEmail = useAuth((s) => s.email);
  const [rows, setRows] = useState<EditRow[]>([]);
  // 自动同步间隔（毫秒；0=关闭），存 localStorage 供 App 级定时器使用。
  // ⚠️ 写入口只有 `writeAutoSyncMs`（它会顺便**广播**，让 App 那条定时器重挂 —— 否则面板改了档
  //    而 App 不重渲染，定时器就还按老间隔跑）。
  const [autoMs, setAutoMs] = useState<number>(() => readAutoSyncMs());
  const setAuto = (ms: number) => {
    writeAutoSyncMs(ms);
    setAutoMs(ms);
  };
  // 「近实时推送」（桌面流通道，第 48 轮）：默认开。开关本身与读写口径都在 `lib/nearRealtime.ts`
  //（挂载时起流那条路也读它）—— 这里只做界面：拨一下 ⇒ **立刻**起/停（不等重开页面）。
  const [nearRealtime, setNearRealtime] = useState<boolean>(() => isNearRealtimeEnabled());
  const toggleNearRealtime = async (on: boolean) => {
    setNearRealtime(on); // 先动界面（乐观），失败再回滚并如实说
    try {
      await applyNearRealtime(on);
      setStatus(on ? "已开启近实时推送" : "已关闭近实时推送（改为按间隔轮询）");
    } catch (e) {
      setNearRealtime(!on);
      setStatus(`近实时切换失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // 「同步方式」（2026-09-26 口径收敛）：原来这里是**两个**控件 —— 自动同步间隔四档 ＋ 近实时开关；
  // 它们管的是同一件事的两个旋钮，用户还得在脑子里把两件事叠起来算。现在合成**一个**三选一，
  // 映射与那句人话都在 `lib/syncMode.ts`（**唯一一处**），这里只负责调它。
  const syncMode = syncModeOf(autoMs, nearRealtime);
  const applySyncMode = (mode: SyncMode) => {
    const next = settingsForMode(mode);
    setAuto(next.autoMs);
    // ⚠️ 近实时那半边不只是改 state：`applyNearRealtime` 会**立刻**起/停那条流（不等重开页面），
    //    并且把开关落盘（`lib/nearRealtime.ts` 一处实现）。
    void toggleNearRealtime(next.nearRealtime);
  };
  const [status, setStatus] = useState("");
  // 甲-1 接线第 3 件：**局域网发现的读数**（`lan_status`）。只在**桌面且面板开着**时轮询 ——
  // 发现层是进程常驻的（`setup` 里就起了），面板关着就没人看这一行（少一次 IPC/秒）。
  // ⚠️ `line` 是 Rust 侧 `lan::status_line` 的**原文**，这里**只显示、不解释**（档位由 Route 决定）。
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null);
  useEffect(() => {
    if (!open || !isDesktopPlatform()) return;
    let alive = true;
    const tick = async () => {
      try {
        const st = await api.lanStatus(activeId);
        if (alive) setLanStatus(st);
      } catch {
        // 读不到（命令没注册 / 老构建）⇒ 这一行**不显示**，别把它装成"没有发现到对端"。
        if (alive) setLanStatus(null);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, activeId]);
  // ⚠️ 只有**当前空间这条档案绑全了**才显示那一行：`lan_status` 没绑定时会回落"第一条绑定"
  //（那是给无参调用兜底的），在面板上显示**别的空间**的地址是错的。
  const activeRow = rows.find((r) => r.ws_id === activeId);
  const lanRowBound = !!activeRow && !!activeRow.server_url.trim() && !!activeRow.space_id.trim();
  // 丙-③-b-2b-2：**网格（对等交换）**那一档的设置面。
  // ⚠️ 三个输入各自独立，保存时按命令面的口径给值（`""` ＝ 清除那一项、`null` ＝ 不动）——
  //   这里**不再自己解释一遍**（两处各解释一次，迟早会有一处说错）。
  // ⚠️ 它的门槛**不是** `lanRowBound`：网格**不需要**服务端地址，只要求这个空间有 `space_id`
  //   （"只开网格、不绑服务端"正是这一档要支持的配置）。
  const [meshBind, setMeshBind] = useState("");
  const [meshToken, setMeshToken] = useState("");
  const [meshBusy, setMeshBusy] = useState(false);
  const meshSavedBind = lanStatus?.mesh.bind ?? "";
  // 只在**读数里的值变了**时回填：用户正在输入时轮询到的是同一份值 ⇒ 不会覆盖他打的字。
  useEffect(() => {
    setMeshBind(meshSavedBind);
  }, [meshSavedBind]);
  const saveMeshBind = async () => {
    setMeshBusy(true);
    try {
      const st = await api.meshSetConfig(activeId, meshBind.trim(), null);
      setStatus(st.note);
    } catch (e) {
      setStatus(`网格设置没保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };
  const saveMeshToken = async () => {
    if (!meshToken.trim()) return;
    setMeshBusy(true);
    try {
      const st = await api.meshSetConfig(activeId, null, meshToken.trim());
      setMeshToken("");
      setStatus(st.note);
    } catch (e) {
      setStatus(`网格口令没保存：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };
  const disableMesh = async () => {
    setMeshBusy(true);
    try {
      // `""` ＝ **清除监听地址** ⇒ 网格关掉、窗口立刻松口（与命令面同一套口径）。
      const st = await api.meshSetConfig(activeId, "", null);
      setStatus(st.note);
    } catch (e) {
      setStatus(`网格没关掉：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMeshBusy(false);
    }
  };
  // ⚠️ 这里原来还有一个 `meshRoundNow()`（配一个「立刻交换一轮」按钮）。2026-09-26 **口径收敛**：
  //    交换并进「同步」（见 `syncOne` 里那一段）⇒ 函数与按钮**一起删掉**，不留在那儿当"看起来
  //    还该有个按钮"的线索（本仓对死代码的纪律在 TS 这半边同样适用）。
  const [syncing, setSyncing] = useState(false);
  // C1 预算刹车：设备级设置（null = 还没读到，此时不渲染这一块）。
  const [budget, setBudget] = useState<SyncBudget | null>(null);
  const [budgetBusy, setBudgetBusy] = useState(false);
  // C2 网络闸门：当前网络类型。**用真实查询结果当"这台机器支不支持这条闸门"的判据**，
  // 而不是拿 UA / 平台名去近似（`network_type` 在非 Android 上回 `"n/a"` = 不适用）。
  const [netKind, setNetKind] = useState<string>("n/a");
  // 实时同步状态（正在推送/拉取/附件进度），由同步引擎在 web.ts 上报。
  // ⚠️ 与上面那个**本面板自己的** `syncing`（手动同步在跑）不是一个东西，故叫 liveSyncing。
  // 收窄到具体字段：整店订阅会让"任何一次 setProgress"都重渲染整个面板（1171 行，
  // 含冲突列表与历史），而同步期间每传一件附件就写一次进度。字段级订阅与
  // `PageTree` 里 label/x/y/kind 的写法一致（本仓既有风格，不引入 useShallow）。
  const liveSyncing = useSyncStatus((s) => s.syncing);
  const syncPhase = useSyncStatus((s) => s.phase);
  const syncMessage = useSyncStatus((s) => s.message);
  const attCurrent = useSyncStatus((s) => s.attCurrent);
  const attTotal = useSyncStatus((s) => s.attTotal);
  const attName = useSyncStatus((s) => s.attName);
  const syncDurationMs = useSyncStatus((s) => s.durationMs);
  const [loggingIn, setLoggingIn] = useState(false);
  const [history, setHistory] = useState<{ ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string; title: string }[] }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailOpenIdx, setDetailOpenIdx] = useState<number | null>(null);
  // P0.1 同页冲突提示：sync_workspace 返回的 dirty 冲突页，用户选择保留/采用。
  const [conflicts, setConflicts] = useState<{ ws_id: string; entity_id: string; title: string }[]>([]);
  // ★ B 方案（2026-09-22）：**待取回的远端版本**（页级保留本地时存下来的那一版）。
  // 修好之前这一支是**完全静默**的：游标过去了、对端那笔编辑再也取不回、层里一条痕都没有。
  const [pending, setPending] = useState<{ page_id: string; title: string; seq: number }[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);

  /** 读待取回清单（面板打开 / 每次同步之后）。失败不打扰用户：它只是提示面。 */
  const loadPendingRemote = async () => {
    try {
      const q = await api.listPendingRemotePages(20);
      setPending((q?.pages ?? []) as { page_id: string; title: string; seq: number }[]);
      setPendingTotal(Number(q?.total ?? 0));
    } catch {
      setPending([]);
      setPendingTotal(0);
    }
  };

  /**
   * 裁决**一处**待取回的远端版本。三个选项都**真的动数据** ——
   * 旧横幅那两条按钮只改一行文案（取证文件 §4 的 F3），这一版不是。
   */
  const resolveOne = async (pageId: string, choice: "merge" | "take_remote" | "keep_local") => {
    try {
      const rep = await api.resolvePendingRemote(pageId, choice);
      const what =
        choice === "merge"
          ? `已合并（${rep.merged ? "逐块合并" : "用远端原样"}${rep.unresolved ? `，还有 ${rep.unresolved} 处要逐块裁决` : ""}）`
          : choice === "take_remote"
            ? `已采用远端版本（放弃本地未推送改动 ${rep.discarded_local_changes} 笔）`
            : "已保留本地（下次同步会推送你这份）";
      setStatus(what);
    } catch (e) {
      setStatus(`裁决失败：${e}`);
    }
    await loadPendingRemote();
    await useNotes.getState().loadPages();
  };

  /** 横幅上那两颗按钮：对**当前这批冲突页**批量按同一口径收场。 */
  const resolveAll = async (choice: "take_remote" | "keep_local") => {
    const ids = Array.from(new Set(conflicts.map((c) => c.entity_id)));
    let done = 0;
    for (const id of ids) {
      try {
        await api.resolvePendingRemote(id, choice);
        done++;
      } catch {
        /* 单页失败不挡其它页；下一次同步还会把它带出来 */
      }
    }
    setConflicts([]);
    setStatus(
      choice === "keep_local"
        ? `已保留本地改动（${done} 页；下次同步会推送你这份）`
        : `已采用服务端版本（${done} 页；本地未推送的改动已真的放弃）`,
    );
    await loadPendingRemote();
    await useNotes.getState().loadPages();
  };

  const refresh = async () => {
    try {
      const profiles = await api.listSyncProfiles();
      const name = new Map(spaces.map((s) => [s.id, s.name]));
      // 已删除的工作空间不该在这里露出（否则只剩一行裸 UUID）。后端已按
      // meta.workspaces 过滤，这里再挡一层：空间列表已加载时，只认识得出名字的
      // 空间；列表尚未加载（首帧）时退回并集，避免面板空白。
      // 只显示当前活动空间：打开同步面板聚焦当前正在用的空间，而不是列出所有。
      // 当 activeId 存在时只取它；无活动空间（首帧）退回并集避免空白。
      let ids: string[];
      if (activeId) {
        ids = [activeId];
      } else {
        const known = spaces.length > 0;
        const profileIds = profiles.map((p) => p.ws_id).filter((id) => !known || name.has(id));
        ids = Array.from(new Set([...spaces.map((s) => s.id), ...profileIds]));
      }
      const byWs = new Map<string, SyncProfile>(profiles.map((p) => [p.ws_id, p]));
      // 同步/保存过（有 server_url）的空间，默认填入上次登录的邮箱。
      const serverEmail = new Map<string, string>();
      // 已绑定空间的可选项（remoteSpaces）：有 token 时拉取，保证 space_id 能
      // 匹配到名称显示下拉（否则刷新后变回手填裸 id）。
      const remoteByServer = new Map<string, ServerSpace[]>();
      for (const id of ids) {
        const p = byWs.get(id);
        const sv = p?.server_url;
        if (sv && !serverEmail.has(sv) && !remoteByServer.has(sv)) {
          const em = await api.teamGetServerEmail(sv).catch(() => "");
          if (em) serverEmail.set(sv, em);
          if (p?.token) {
            const list = await api.teamListSpaces(sv, p.token).catch(() => [] as ServerSpace[]);
            remoteByServer.set(sv, list);
          }
        }
      }
      setRows(
        ids.map((id) => {
          const p = byWs.get(id);
          return {
            ws_id: id,
            name: name.get(id) ?? id,
            server_url: p?.server_url ?? "",
            token: p?.token ?? "",
            space_id: p?.space_id ?? "",
            // 有 server_url 时预填上次登录邮箱；否则空。
            loginEmail: p?.server_url ? (serverEmail.get(p.server_url) ?? "") : "",
            loginPassword: "",
            loginRegisterCode: "",
            authMode: "login",
            remoteSpaces: p?.server_url ? (remoteByServer.get(p.server_url) ?? []) : [],
            members: [],
            memberOpen: false,
            inviteEmail: "",
            inviteRole: "editor",
            // 缺省 1（开）：老库升级上来没有这一列时的存量行为必须保持不变。
            syncAttachments: (p?.sync_attachments ?? 1) === 1,
          };
        }),
      );
      await loadHistory();
      await loadPendingRemote();
    } catch (e) {
      setStatus(String(e));
    }
  };

  // C1/C2：读设备级预算与当前网络类型。**失败不弹错**——这两个是"锦上添花"的设置，
  // 读不到时面板少一块，但同步本身照样能用。
  const refreshBudget = async () => {
    const [b, kind] = await Promise.all([
      api.getSyncBudget().catch(() => null),
      api.networkType().catch(() => "n/a"),
    ]);
    if (b) setBudget(b);
    setNetKind(kind || "n/a");
  };

  // C1：写预算。⚠️ 用**返回值**刷新自己——磁盘余量下限**不可关**，Rust 侧会把不合法的值夹回去
  // （比如传 0 会回 256）。不采纳返回值的话，界面会显示一个数据库里并不存在的数。
  const saveBudget = async (next: SyncBudget) => {
    setBudgetBusy(true);
    try {
      setBudget(await api.setSyncBudget(next));
    } catch (e) {
      setStatus(`同步预算保存失败：${e}`);
    } finally {
      setBudgetBusy(false);
    }
  };

  // 同步历史（最新 15 条）。
  const loadHistory = async () => {
    try {
      const h = await api.listSyncHistory(15).catch(() => [] as { ws_id: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string; title: string }[] }[]);
      if (h.length) setHistory(h);
    } catch (e) {
      setStatus(String(e));
    }
  };

  // 清空同步历史（本地 meta.only）。
  const clearHistory = async () => {
    try {
      await api.clearSyncHistory();
      setHistory([]);
      setStatus("同步历史已清空");
    } catch (e) {
      setStatus(`清空失败：${e}`);
    }
  };

  useEffect(() => {
    if (open) {
      void refresh();
      // C1/C2 的设备级设置与网络类型（与 profile 列表分开读：它们失败也不该让面板空白）。
      void refreshBudget();
    }
    // 打开面板 / 切换活动空间 / 空间列表变化时，都刷新到当前活动空间。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, spaces]);

  const save = async (r: EditRow) => {
    try {
      await api.setSyncProfile(r.ws_id, { server_url: r.server_url, token: r.token || undefined, space_id: r.space_id || undefined, email: r.loginEmail.trim() || undefined });
      setStatus(`已保存「${r.name}」`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const syncOne = async (r: EditRow) => {
    // 点「同步」先做前置校验，规范数据才发后端，避免无效请求 / 误导性报错。
    if (!r.server_url.trim()) { setStatus("请先填服务器地址"); return; }
    if (!r.token) { setStatus("请先登录（没有账号请先「注册」）"); return; }
    if (!r.space_id) { setStatus(`请先绑定组织空间${r.remoteSpaces.length ? "（在上方下拉选择一个）" : "（还没有空间就点「创建空间」，或让管理员邀请你加入）"}`); return; }
    setSyncing(true);
    setStatus("");
    useSyncStatus.getState().begin("正在同步…");
    // B2（2026-09-15）：**必须配对 end()**。此前只有 `web.ts` 调 `end()`，桌面 / Android 走
    // Rust 命令、不会自己调 ⇒ store 的 `syncing` **永远是 true**，于是面板一直显示"正在同步…"，
    // 而下面那些 `setStatus("…同步完成…")` 的结果文案被 `syncStatus.syncing` 的分支挡住、永远看不到。
    // 把错误一并带出去，让 `end()` 能落到 `phase: "error"`。
    //
    // 这一步同时是 **P6.1（每空间开关）的前置**：P6.1 要求"中途关掉开关 ⇒ 面板报告
    // *因开关关闭而停止*"，而没有结束态就没有地方显示停止原因。
    let syncErr: string | null = null;
    try {
      const res = await api.syncWorkspace(r.ws_id);
      if (res.error) {
        syncErr = String(res.error);
        setStatus(`「${r.name}」同步失败：${res.error}`);
      } else {
        // P6.1：开关关闭（或同步途中被关掉）时，引擎会跳过附件并在返回值里带 paused
        // 标记。不显示这一句的话，"附件没同步"看起来就像同步失败 / 丢文件。
        // ⚠️ 停止时文案**不能出现"同步完成"**（§六 验收 #8 明确要求"因开关关闭而停止"
        // 而不是"同步完成"）——否则用户以为附件也都对齐了。
        // "未上传 N 个 / 未下载 M 个"来自引擎的两份清单差集（§六 验收 #4）。
        const bits = [
          res.attachments_skipped_upload > 0 ? `未上传 ${res.attachments_skipped_upload} 个` : "",
          res.attachments_skipped_download > 0 ? `未下载 ${res.attachments_skipped_download} 个` : "",
          // C1：被单文件阈值挡下的（不是"停止"，是"轮不到"）。
          res.attachments_skipped_too_large > 0 ? `${res.attachments_skipped_too_large} 个超过单文件上限` : "",
          // C1：**本该传但没传成**的——必须单独说，否则就是静默丢件。
          res.attachments_failed > 0 ? `${res.attachments_failed} 个传输失败` : "",
          res.attachments_bytes_downloaded > 0 ? `本次下载 ${fmtMb(res.attachments_bytes_downloaded)}` : "",
        ].filter(Boolean).join(" / ");
        const att = bits ? `（${bits}）` : "";
        // C1：停止原因要说清是**哪一种**——"附件同步已关闭"和"磁盘要满了"对用户是两件事。
        const stopReason =
          res.attachments_paused_reason === "disk_floor"
            ? "同步已停止：磁盘余量低于下限（可在下方调低「磁盘余量下限」）"
            : res.attachments_paused_reason === "run_cap"
              ? "同步已停止：已达「本次下载总量上限」"
              : "同步已停止：途中关闭了附件同步";
        setStatus(
          res.attachments_paused
            ? `「${r.name}」${stopReason}，已下载的附件保留${att}；上传 ${res.pushed} / 拉取 ${res.pulled}`
            : bits
              ? `「${r.name}」同步完成${att}：上传 ${res.pushed} / 拉取 ${res.pulled}`
              : `「${r.name}」同步完成：上传 ${res.pushed} / 拉取 ${res.pulled}`,
        );
        // P0.1：有同页冲突（本地未推送 + 服务端新 seq）→ 提示用户选择。
        const c = (res.conflicts ?? []) as { entity_id: string; title: string }[];
        if (c.length > 0) {
          setConflicts(c.map((x) => ({ ws_id: r.ws_id, entity_id: x.entity_id, title: x.title })));
        }
      }
      await useNotes.getState().loadPages();
      await loadHistory();
      await loadPendingRemote();
    } catch (e) {
      syncErr = String(e);
      setStatus(`「${r.name}」同步失败：${e}`);
    } finally {
      // ★ 丙-③-b（2026-09-26 口径收敛）：**网格那一档并进「同步」**——同一个按钮，服务端那条走完
      //   再对这个空间跑一轮对等交换（原来它有一个单独的「立刻交换一轮」按钮：一个意图两个动作）。
      //
      // ⚠️ ⚠️ **必须放在 `finally` 里，不许放在 `try` 里** —— 真机上实测踩过：服务端那条**抛错**时
      //   （现场是"会话已失效，请重新登录"），`try` 里剩下的语句**一行都不会跑** ⇒ 网格这一档被
      //   连坐跳过，而它**根本不依赖服务端**（网格是客户端之间直连）。与 `round` 里那条
      //   "一只对端拉不动不连坐"是同一条纪律。
      // ⚠️ 只在**这一行就是面板上显示的那行**、且网格真开着时才跑：`lanStatus.mesh` 是**当前那条档案**
      //   的读数（面板只为它显示网格那一块），拿别行的 ws_id 去跑会与读数对不上。
      // ⚠️ "没配网格 ⇒ 一个字节都不动"由 Rust 侧（`mesh_sync_now` 早退）保证，这里**不重判一遍**。
      if (lanStatus?.mesh.enabled && r.ws_id === activeId) {
        try {
          const rep = await api.meshSyncNow(r.ws_id);
          // ⚠️ `rep.note` **自带**「网格：」前缀（Rust 拼好的人话）—— 这里别再写一遍，
          //    否则真机上会看到 `网格：网格：拉了 1 台对端`（第一版就是这么出去的）。
          setStatus((prev) => `${prev}${prev ? "；" : ""}${rep.note}`);
        } catch (e) {
          setStatus((prev) => `${prev}${prev ? "；" : ""}网格交换失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setSyncing(false);
      useSyncStatus.getState().end(syncErr);
    }
  };

  const update = (ws_id: string, field: keyof EditRow, value: string) =>
    setRows((rs) => rs.map((r) => (r.ws_id === ws_id ? { ...r, [field]: value } : r)));

  // P6.1 每空间「附件同步」开关。两条容易踩的坑，都在这里挡掉：
  //
  // ① **必须走窄命令 `setSyncAttachments`，不能顺手用 `setSyncProfile`**：后者的语义是
  //    "没传的字段 = 清空"（Rust `sync.rs` 的 `token.as_deref().unwrap_or("")`，web.ts 同
  //    语义），为了存一个开关而调用它会把该行的 token / space_id 一起抹掉。
  // ② **必须立即落盘，不能等用户点「保存」**：这个开关的用途之一就是"同步跑到一半关掉
  //    刹车"，同步引擎读的是数据库里的值；只存在面板 state 里的话，跑到一半关 = 关了个
  //    寂寞，得等下一次点「同步」才生效。落盘失败要把 UI 回滚，否则显示成"已关"其实没关。
  const setAttachments = async (r: EditRow, enabled: boolean) => {
    setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, syncAttachments: enabled } : x)));
    try {
      await api.setSyncAttachments(r.ws_id, enabled);
      setStatus(
        enabled
          ? `「${r.name}」已开启附件同步`
          : `「${r.name}」已关闭附件同步：同步时只走笔记内容，不传附件文件`,
      );
    } catch (e) {
      setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, syncAttachments: !enabled } : x)));
      setStatus(`附件同步开关保存失败：${e}`);
    }
  };

  // 登录与注册共用的收尾：token 落到该行 + auth store + **落盘**，并尽力拉一次
  // 空间列表（列表失败不回滚会话——token 已有效，用户仍可手填空间 id）。
  //
  // 自动保存是必须的：此前登录只把 token 放进面板的临时 state，用户不点「保存」
  // 就关掉面板等于白登一次——而「刚登录完还要再点保存」本身就不该存在。
  // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
  // 避免残留旧账号会话导致 401/数据错乱。保留各自 server_url。
  const cleanOtherServerTokens = async (base: string, token: string) => {
    const profiles = await api.listSyncProfiles();
    const target = profiles.filter((p) => p.server_url === base);
    for (const p of target) {
      await api.setSyncProfile(p.ws_id, { server_url: base, token, space_id: p.space_id }).catch(() => {});
    }
  };

  const applySession = async (r: EditRow, base: string, token: string, what: string) => {
    const list = await api.teamListSpaces(base, token).catch(() => [] as ServerSpace[]);
    setRows((rs) =>
      rs.map((x) => (x.ws_id === r.ws_id ? { ...x, server_url: base, token, loginPassword: "", remoteSpaces: list } : x)),
    );
    useAuth.getState().setSession(base, token, r.loginEmail?.trim());
    let saved = true;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token,
        space_id: r.space_id || undefined,
      });
    } catch (e) {
      saved = false;
      console.error("auto-save sync profile failed", e);
    }
    // 同服务器其它空间的绑定指向旧账号 token：登录（换账号）后统一覆盖为当前 token，
    // 避免残留旧账号的会话导致 401/数据错乱（这也是之前 401 的同类根源）。
    // 保留各自 server_url，仅更新 token/space。
    await cleanOtherServerTokens(base, token).catch((e) => console.error("clean other sync tokens failed", e));
    setStatus(
      saved
        ? `${what}成功「${r.name}」，已保存${list.length ? `，可选空间 ${list.length} 个` : ""}`
        : `${what}成功，但保存失败——请手动点「保存」`,
    );
  };

  const login = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      // 走 Rust 代理命令（绕 WebView2 CORS）：服务端无 CORS 层，前端 fetch 会被拦。
      const { token } = await api.teamLogin(base, r.loginEmail.trim(), r.loginPassword);
      if (!token) throw new Error("服务器未返回 token");
      await applySession(r, base, token, "登录");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const noAuth = e?.status === 401 || /401/.test(msg);
      setStatus(
        noAuth ? "登录失败：邮箱或密码不对（没有账号请先「注册」）" : `登录失败：${msg}`,
      );
    } finally {
      setLoggingIn(false);
    }
  };

  // 注册：在该服务器开新账号。服务端 /auth/register 成功后直接下发会话 token，
  // 所以注册即登录，不需要再点一次登录。密码规则与服务端一致（≥8 位）。
  const register = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) { setStatus("请先填服务器地址"); return; }
    if (!r.loginEmail.trim() || !r.loginPassword) { setStatus("请输入邮箱和密码"); return; }
    if (r.loginPassword.length < 8) { setStatus("注册失败：密码至少 8 位"); return; }
    // 邀请码必填：客户端直接拦下，不打扰服务端（也避免控制台 400）。
    if (!r.loginRegisterCode.trim()) { setStatus("注册失败：请输入「注册邀请码」（向管理员索取，如 SHUYOABC）"); return; }
    setLoggingIn(true);
    setStatus("");
    try {
      const { token } = await api.teamRegister(base, r.loginEmail.trim(), r.loginPassword, null, r.loginRegisterCode.trim() || null);
      if (!token) throw new Error("服务器未返回 token");
      await applySession(r, base, token, "注册");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const st = e?.status;
      let hint = st === 409 || /409/.test(msg) ? "该邮箱已注册，请直接「登录」"
        : st === 400 || /400/.test(msg) ? "请输入「注册邀请码」（向管理员索取，如 SHUYOABC）且密码 ≥ 8 位"
        : st === 401 || /401/.test(msg) ? "登录失败：邮箱或密码不对（没有账号请先「注册」）"
        : `注册失败：${msg}`;
      setStatus(hint);
    } finally {
      setLoggingIn(false);
    }
  };

  // ---- M27 成员管理 handlers ----
  const toggleMembers = (r: EditRow) => {
    setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, memberOpen: !x.memberOpen } : x)));
    if (!r.memberOpen && r.space_id && r.token) void loadMembers(r);
  };

  const loadMembers = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    setStatus("");
    try {
      const members = await api.teamListMembers(base, r.token, r.space_id);
      setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, members } : x)));
    } catch (e) {
      setStatus(`成员拉取失败：${e}`);
    }
  };

  const inviteMember = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.space_id || !r.token) { setStatus("请先登录并绑定空间"); return; }
    if (!r.inviteEmail.trim()) { setStatus("请输入被邀请者邮箱"); return; }
    setStatus("");
    const email = r.inviteEmail.trim();
    const role = r.inviteRole;
    try {
      await api.teamInviteMember(base, r.token, r.space_id, email, role);
      await loadMembers({ ...r, inviteEmail: "" });
      setStatus(`已邀请 ${email}`);
    } catch (e) {
      const msg = String(e);
      // 服务端空间邀请要求用户已注册；未注册返回 404。给友好提示。
      setStatus(
        /404|Not Found|not found/i.test(msg)
          ? `「${email}」尚未注册：请让对方先注册账号，或由组长发送邀请码邀请`
          : `邀请失败：${msg}`,
      );
    }
  };

  const removeMember = async (r: EditRow, userId: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamRemoveMember(base, r.token, r.space_id, userId);
      await loadMembers(r);
      setStatus("已移除成员");
    } catch (e) {
      setStatus(`移除失败：${e}`);
    }
  };

  const setMemberRole = async (r: EditRow, email: string, role: string) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    try {
      await api.teamSetMemberRole(base, r.token, r.space_id, email, role);
      await loadMembers(r);
      setStatus("已更新角色");
    } catch (e) {
      setStatus(`更新角色失败：${e}`);
    }
  };

  const logout = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    setStatus("");
    try {
      await api.teamLogout(base);
      setRows((rs) =>
        rs.map((x) => (x.ws_id === r.ws_id ? { ...x, token: "", space_id: "", remoteSpaces: [], members: [], memberOpen: false } : x)),
      );
      useAuth.getState().clear();
      // 同样要落盘：否则重开面板时 refresh() 会把旧 token 从库里读回来，
      // 看起来像「登出了又自己登回去」。
      await api.setSyncProfile(r.ws_id, { server_url: base }).catch((e) => {
        console.error("clear sync profile failed", e);
      });
      // 登出成功不显示「已登出」——回到登录表单本身已说明状态，提示是多余噪音。
      setStatus("");
    } catch (e) {
      setStatus(`登出失败：${e}`);
    }
  };

  // 选中空间即落盘：与登录同理——「选完还要再点保存」是多余的一步，
  // 忘了点就等于没绑。手填服务器地址/令牌仍走「保存」按钮。
  const pickSpace = async (r: EditRow, spaceId: string) => {
    update(r.ws_id, "space_id", spaceId);
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base) return;
    try {
      await api.setSyncProfile(r.ws_id, {
        server_url: base,
        token: r.token || undefined,
        space_id: spaceId || undefined,
      });
      const name = r.remoteSpaces.find((x) => x.id === spaceId)?.name;
      setStatus(spaceId ? `已绑定空间「${name ?? spaceId}」` : "已解除空间绑定");
    } catch (e) {
      setStatus(`保存失败：${e}`);
    }
  };

  // 创建组织空间：当前登录账号在服务器上新建一个空间，创建后自动绑定。
  // 新注册账号往往没有任何空间，必须直接给入口，否则「登录了却不知道选什么/填什么」。
  const createSpace = async (r: EditRow) => {
    const base = r.server_url.trim().replace(/\/+$/, "");
    if (!base || !r.token) { setStatus("请先登录再创建组织空间"); return; }
    inputDialog({
      title: "创建组织空间",
      placeholder: "空间名称",
      defaultValue: "",
      onSubmit: async (name) => {
        const n = name.trim();
        if (!n) return;
        try {
          const sp = await api.teamCreateSpace(base, r.token, n);
          const ids = Array.isArray(r.remoteSpaces) ? r.remoteSpaces : [];
          setRows((rs) => rs.map((x) => (x.ws_id === r.ws_id ? { ...x, remoteSpaces: [...ids, sp], space_id: sp.id } : x)));
          await api.setSyncProfile(r.ws_id, { server_url: base, token: r.token, space_id: sp.id }).catch(() => {});
          setStatus(`已创建组织空间「${sp.name}」并绑定`);
        } catch (e) {
          setStatus(`创建组织空间失败：${e}`);
        }
      },
    });
  };

  // 当前用户在该绑定空间的角色是否可管理成员（admin/owner）。viewer/editor 只读。
  const canManageSpace = (r: EditRow): boolean => {
    const role = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
    return role === "admin" || role === "owner";
  };

  // 状态条只有一行文案，按语义上色：失败=红、提示性前置条件=黄、其余=绿。
  const statusKind = (s: string): "ok" | "err" | "warn" =>
    /失败|错误|不支持|不存在|无效/.test(s) ? "err" : /^请/.test(s) ? "warn" : "ok";

  const roleClass = (role: string) =>
    ["owner", "admin", "editor", "viewer"].includes(role) ? `role-${role}` : "role-viewer";

  const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="sync-panel">
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="同步设置">
        <CloudSyncIcon width={14} height={14} />
        <span>同步</span>
        {liveSyncing && <span className="sync-pulse" aria-hidden />}
      </button>
      {open && (
        <div
          ref={contentRef}
          className={`sync-popover is-sync${isSheet ? " is-sheet" : ""}`}
          style={{ top: pos.top, left: pos.left }}
          role="dialog"
          aria-label="同步设置"
        >
          <header className="sync-head">
            <div className="sync-head-text">
              <div className="sync-title">同步</div>
              <div className="sync-subtitle">每个空间各自绑定服务器与组织空间</div>
            </div>
            {/* 顶部胶囊反映【当前激活空间】的绑定状态（与该空间卡片一致），
                避免全局 authed 显示"已登录"但当前空间仍显示登录表单的矛盾。 */}
            <span className={`sync-chip${rows.some((r) => r.ws_id === activeId && r.token) ? " is-on" : ""}`}>
              {rows.some((r) => r.ws_id === activeId && r.token) ? "已登录" : "未登录"}
            </span>
          </header>

          {!isDesktopPlatform() && (
            <div className="sync-web-note">建议使用桌面版以获得稳定多设备同步；Web 版同步受浏览器环境限制。</div>
          )}
          {conflicts.length > 0 && (
            <div className="sync-conflict-banner" role="alert">
              <div className="sync-conflict-title">⚠️ 有页面被多人同时修改</div>
              <ul className="sync-conflict-list">
                {conflicts.map((c) => (
                  <li key={c.entity_id}>《{c.title}》</li>
                ))}
              </ul>
              <div className="sync-conflict-actions">
                <button onClick={() => void resolveAll("keep_local")} className="btn-sync-conflict keep">
                  保留本地
                </button>
                <button onClick={() => void resolveAll("take_remote")} className="btn-sync-conflict adopt">
                  采用服务端
                </button>
              </div>
              <div className="sync-conflict-hint">
                提示：你在这些页有未推送的改动，另一台设备改了同一页。**远端那一版已经存在本地**（不会因为游标走过去而丢）：
                选「保留本地」= 你这份优先（下次同步推上去）；选「采用服务端」= 真的放弃本地未推送的改动。
              </div>
            </div>
          )}
          {pending.length > 0 && (
            <div className="sync-pending-remote" role="status">
              <div className="sync-conflict-title">📥 待取回的远端版本（{pendingTotal} 页）</div>
              <ul className="sync-conflict-list">
                {pending.map((p) => (
                  <li key={p.page_id}>
                    《{p.title || "（无标题）"}》
                    <span className="sync-pending-actions">
                      <button onClick={() => void resolveOne(p.page_id, "merge")}>合并这一页</button>
                      <button onClick={() => void resolveOne(p.page_id, "take_remote")}>采用远端</button>
                      <button onClick={() => void resolveOne(p.page_id, "keep_local")}>保留本地</button>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="sync-conflict-hint">
                这些页面当时**保留了本地**（本地有未推送的改动），对端那一版已替你存下 —— 三个选项都会**真的改数据**。
              </div>
            </div>
          )}
          {/* 隐私边界 ②b（2026-09-24）：**这个空间敢不敢绑同步**（分类 ＋ 加密 ＋ 闸门裁决）。
              ⚠️ 放在这一屏是因为闸门拦的正是「绑同步」这个动作（`sync::sync_bind_gate`）——
              读数与动作同屏，用户不用去别处找「为什么绑不上」。
              平台判定在组件内部（Web 上只渲染解释句、一次 api 都不调）。 */}
          <SpacePrivacySection nameOf={(id) => spaces.find((s) => s.id === id)?.name ?? id} />
          <div className={`sync-profiles${isDesktopPlatform() ? "" : " is-disabled"}`}>
            {rows.length === 0 && <div className="sync-empty-state">还没有可配置的空间</div>}
            {rows.map((r) => {
              const myRole = r.remoteSpaces.find((x) => x.id === r.space_id)?.role ?? "";
              const state = r.server_url && r.space_id ? "bound" : r.server_url ? "partial" : "none";
              return (
                <section key={r.ws_id} className="sync-card">
                  <div className="sync-card-head">
                    <span className="sync-card-avatar" aria-hidden>{initial(r.name)}</span>
                    <span className="sync-card-name" title={r.name}>{r.name}</span>
                    <span className={`sync-state is-${state}`}>
                      {state === "bound" ? "已绑定" : state === "partial" ? "待选空间" : "未配置"}
                    </span>
                  </div>

                  <div className="sync-field">
                    <label htmlFor={`sync-srv-${r.ws_id}`}>服务器</label>
                    <input
                      id={`sync-srv-${r.ws_id}`}
                      className="sync-input"
                      value={r.server_url}
                      placeholder="http://localhost:8787"
                      onChange={(e) => update(r.ws_id, "server_url", e.target.value)}
                    />
                  </div>

                  {/* 已拿到令牌就不再堆登录表单——只留一枚「已登录」胶囊 + 登出。 */}
                  {r.token ? (
                    <div className="sync-account">
                      <span className="sync-account-dot" aria-hidden />
                      <div className="sync-account-text">
                        <b>{authEmail || "已登录"}</b>
                        <span title={r.server_url}>{r.server_url || "—"}</span>
                      </div>
                      {/* 管理账号/组织：跳转到设置中心「账户」页（登录身份、组织管理、注销）。 */}
                      <button className="sync-btn ghost" onClick={() => useEditorStore.getState().openSettings("account")}>管理</button>
                      <button className="sync-btn ghost" onClick={() => void logout(r)}>登出</button>
                    </div>
                  ) : (
                    <div className="sync-field">
                      <label htmlFor={`sync-mail-${r.ws_id}`}>账号</label>
                      {/* 登录/注册 tab：登录只需邮箱+密码；注册需额外 注册邀请码。 */}
                      <div className="sync-auth-tabs">
                        <button
                          className={`sync-tab${r.authMode === "login" ? " on" : ""}`}
                          onClick={() => update(r.ws_id, "authMode", "login")}
                        >登录</button>
                        <button
                          className={`sync-tab${r.authMode === "register" ? " on" : ""}`}
                          onClick={() => update(r.ws_id, "authMode", "register")}
                        >注册</button>
                      </div>
                      <div className="sync-auth-grid">
                        <input
                          id={`sync-mail-${r.ws_id}`}
                          className="sync-input"
                          value={r.loginEmail}
                          placeholder="邮箱"
                          autoComplete="username"
                          onChange={(e) => update(r.ws_id, "loginEmail", e.target.value)}
                        />
                        <input
                          className="sync-input"
                          type="password"
                          value={r.loginPassword}
                          placeholder="密码"
                          autoComplete="current-password"
                          onChange={(e) => update(r.ws_id, "loginPassword", e.target.value)}
                        />
                      </div>
                      {r.authMode === "register" && (
                        <div className="sync-field" style={{ marginTop: 8 }}>
                          <label htmlFor={`sync-regcode-${r.ws_id}`}>注册邀请码（必填）</label>
                          <input
                            id={`sync-regcode-${r.ws_id}`}
                            className="sync-input"
                            value={r.loginRegisterCode}
                            placeholder="比如：SHUYOABC"
                            onChange={(e) => update(r.ws_id, "loginRegisterCode", e.target.value)}
                          />
                          <p className="sync-hint">
                            {r.server_url ? "注册必须有邀请码。把服务端管理员给你的邀请码填到这里（填错或留空会注册失败）。" : "需先填服务器地址。"}
                          </p>
                        </div>
                      )}
                      <div className="sync-auth-btns">
                        {r.authMode === "login" ? (
                          <button className="sync-btn primary" disabled={loggingIn || !r.server_url} onClick={() => login(r)}>
                            {loggingIn ? "处理中…" : "登录"}
                          </button>
                        ) : (
                          <button className="sync-btn primary" disabled={loggingIn || !r.server_url} onClick={() => register(r)}>
                            {loggingIn ? "处理中…" : "注册"}
                          </button>
                        )}
                      </div>
                      <p className="sync-hint">密码 ≥8 位，注册成功即自动登录。</p>
                    </div>
                  )}

                  <div className="sync-field">
                    <label htmlFor={`sync-space-${r.ws_id}`}>组织空间</label>
                    {r.remoteSpaces.length > 0 ? (
                      <div className="sync-space-row">
                        <select
                          id={`sync-space-${r.ws_id}`}
                          className="sync-input"
                          value={r.space_id}
                          onChange={(e) => void pickSpace(r, e.target.value)}
                        >
                          <option value="">选择我加入的空间…</option>
                          {r.remoteSpaces.map((sp) => (
                            <option key={sp.id} value={sp.id}>{sp.name}</option>
                          ))}
                        </select>
                        {myRole && <span className={`sync-role ${roleClass(myRole)}`}>{myRole}</span>}
                      </div>
                    ) : (
                      <input
                        id={`sync-space-${r.ws_id}`}
                        className="sync-input"
                        value={r.space_id}
                        placeholder="组织空间 id（多设备同步需绑定一个组织空间）"
                        onChange={(e) => update(r.ws_id, "space_id", e.target.value)}
                      />
                    )}
                    {/* 已登录但还没有可绑定的组织空间 → 引导 + 创建入口，避免卡住 */}
                    {r.token && r.remoteSpaces.length === 0 && (
                      <div className="sync-space-guide">
                        <p className="sync-hint">还没有组织空间。点「创建空间」新建一个，或让管理员邀请你加入。</p>
                        <button className="sync-btn primary" onClick={() => createSpace(r)}>创建空间</button>
                      </div>
                    )}
                    {/* 已登录、有空间可选但还没选 → 轻引导 */}
                    {r.token && !r.space_id && r.remoteSpaces.length > 0 && (
                      <p className="sync-hint">请在上面下拉选择一个组织空间，才能同步。</p>
                    )}
                  </div>

                  {r.space_id && r.token && canManageSpace(r) && (
                    <div className="sync-field">
                      <button
                        className="sync-members-toggle"
                        aria-expanded={r.memberOpen}
                        onClick={() => toggleMembers(r)}
                      >
                        <span>成员管理</span>
                        {r.members.length > 0 && <span className="sync-members-count">{r.members.length}</span>}
                        <span className={`sync-caret${r.memberOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                      </button>
                      {r.memberOpen && (
                        <div className="sync-members">
                          {r.members.length === 0 ? (
                            <div className="sync-members-empty">还没有成员</div>
                          ) : (
                            r.members.map((m) => {
                              const canManage = canManageSpace(r);
                              const isOwnerRow = m.role === "owner";
                              return (
                                <div key={m.user_id} className="sync-member">
                                  <span className="sync-member-avatar" aria-hidden>{initial(m.email)}</span>
                                  <span className="sync-member-email" title={m.email}>{m.email}</span>
                                  <select
                                    className={`sync-member-role ${roleClass(m.role)}`}
                                    value={m.role}
                                    aria-label={`${m.email} 的角色`}
                                    disabled={!canManage || isOwnerRow}
                                    onChange={(e) => void setMemberRole(r, m.email, e.target.value)}
                                  >
                                    <option value="viewer">viewer</option>
                                    <option value="editor">editor</option>
                                    <option value="admin">admin</option>
                                  </select>
                                  <button
                                    className="sync-member-remove"
                                    title={isOwnerRow ? "空间所有者不可移除" : "移除成员"}
                                    aria-label={`移除 ${m.email}`}
                                    disabled={!canManage || isOwnerRow}
                                    onClick={() => void removeMember(r, m.user_id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              );
                            })
                          )}
                          <div className="sync-invite">
                            <input
                              className="sync-input"
                              value={r.inviteEmail}
                              placeholder="被邀请者邮箱"
                              disabled={!canManageSpace(r)}
                              onChange={(e) => update(r.ws_id, "inviteEmail", e.target.value)}
                            />
                            <select
                              className="sync-input sync-invite-role"
                              value={r.inviteRole}
                              aria-label="邀请角色"
                              disabled={!canManageSpace(r)}
                              onChange={(e) => update(r.ws_id, "inviteRole", e.target.value)}
                            >
                              <option value="viewer">viewer</option>
                              <option value="editor">editor</option>
                              <option value="admin">admin</option>
                            </select>
                            <button className="sync-btn" disabled={!canManageSpace(r)} onClick={() => void inviteMember(r)}>
                              邀请
                            </button>
                          </div>
                          {!canManageSpace(r) && (
                            <p className="sync-hint">只有 admin / owner 能邀请成员或改角色。</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 手动令牌是老配置法的后路，默认收起，避免面板一眼全是输入框。
                      两用途：① 团队版临时贴一个会话 token；② **「个人自建同步」那一档**
                      （服务端由自己部署、没有账号）—— 把服务端 CLI 签发的那把 `sk_…` 设备密钥
                      贴进来即可，**不需要注册/登录**（服务端侧见 sync-server 的 K1：
                      `--issue-device-key`，持钥即拥有该空间）。 */}
                  <details className="sync-advanced">
                    <summary>高级：手动填令牌 / 设备密钥{r.token ? "（已填）" : ""}</summary>
                    <input
                      className="sync-input"
                      type="password"
                      value={r.token}
                      placeholder="组织 token，或个人自建部署签发的 sk_ 密钥"
                      onChange={(e) => update(r.ws_id, "token", e.target.value)}
                    />
                    <div className="sync-hint">
                      自己部署服务端（无账号）时：在服务器上跑
                      <code> --issue-device-key</code> 拿到一串 <code>sk_…</code>，贴到这里即可；丢了只能重新签发。
                    </div>
                  </details>

                  {/* P6.1 每空间附件开关：默认开。关掉只影响附件**字节**，元数据照常
                      同步——另一端能看到附件条目但打不开，所以文案要说清后果而不是
                      写成"不同步附件"（那听起来像附件也跟着消失）。 */}
                  <div className="sync-att">
                    <div className="sync-att-text">
                      <div className="sync-att-name">同步附件文件</div>
                      <div className="sync-hint">
                        关闭后只同步笔记内容，不传图片 / 附件文件（省流量与磁盘；另一端会看到附件但打不开）。
                        改变立即生效，正在同步的任务会在传完当前文件后停下。
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={r.syncAttachments}
                      aria-label={`同步「${r.name}」的附件文件`}
                      onChange={(e) => void setAttachments(r, e.target.checked)}
                    />
                  </div>

                  <div className="sync-card-actions">
                    {/* 登录/注册与选空间都会自动落盘，这里的「保存」只用于手填
                        服务器地址或手动粘贴令牌的情况。 */}
                    <button className="sync-btn" onClick={() => save(r)} title="保存手填的服务器地址 / 令牌">
                      保存
                    </button>
                    <button className="sync-btn primary" disabled={syncing} onClick={() => syncOne(r)}>
                      {syncing ? "同步中…" : "同步"}
                    </button>
                  </div>
                </section>
              );
            })}
          </div>

          <footer className="sync-foot">
            <div className="sync-auto">
              <span className="sync-auto-label">同步方式</span>
              <select
                className="sync-input"
                value={syncMode}
                onChange={(e) => applySyncMode(e.target.value as SyncMode)}
              >
                <option value="off">关闭</option>
                <option value="interval">按间隔（每 30 秒）</option>
                {/* ⚠️ 只有桌面才有那条流（Web 上是浏览器自带 SSE、没有开关；Rust 侧才有
                    `sync_stream_*`）。Web 上不摆这一档 —— 摆了就是承诺一个不存在的档。 */}
                {isDesktopPlatform() && <option value="realtime">近实时（连着服务端时立刻拉）</option>}
              </select>
            </div>
            <span className="sync-hint sync-auto-hint">{syncModeHint(syncMode)}</span>

            {/* 甲-1 接线第 3 件：**局域网发现的读数**（施工单 §2 ④）＋ 丙-③-b 的**网格读数**。
                口径：**「没走成直连」必须是可断言的结果，不是静默降级** —— 所以这里显示的是
                Rust 侧 `lan::status_line` 的**原文**（"直连（局域网）…" ／ "公网 … ｜ 本网段发现 N 台"
                ／ "…其中没有服务这个空间的中枢" ／ "尚未绑定"），界面**不**自己按地址形状再判一次档。
                ★ 2026-09-26 口径收敛：**地址只说一处** —— 网格那一块的"窗口在哪、别人拉不拉得到"
                （`lanStatus.mesh.note`）也并到这一行里。两处各说一遍地址，看起来就像两个互相矛盾的读数。
                ⚠️ 门槛同时收 `mesh.enabled`：**"只开网格、不绑服务端"** 是丙要支持的配置，
                那种空间没有服务端（`lanRowBound` 假）但这一行照样得有内容。
                只在桌面显示：发现层是 Rust 的 UDP（Web 上没有这一层，`lan_status` 那边如实回"公网"）。 */}
            {isDesktopPlatform() && lanStatus && (lanRowBound || lanStatus.mesh.enabled) && (
              <div className="sync-att sync-lan" title="同一网段里自动找到这个空间的中枢时，同步就走局域网地址">
                <span className="sync-att-text">
                  {/* 标题只按 `kind` 换（那一档来自 Rust 的 Route）；**不**按地址形状自己判。 */}
                  <span className="sync-att-name">
                    {lanStatus.kind === "lan" ? "局域网直连（已走局域网）" : "局域网直连"}
                  </span>
                  <span className="sync-hint">
                    {[lanRowBound ? lanStatus.line : "", lanStatus.mesh.note].filter(Boolean).join(" ｜ ")}
                  </span>
                </span>
              </div>
            )}

            {/* 丙-③-b-2b-2：**网格（对等交换）** —— "不装服务端也能同步"在这里有一个可点的入口。
                ⚠️ 门槛**不是** `lanRowBound`：网格**不需要**服务端地址，只要这个空间有 `space_id`
                （"只开网格、不绑服务端"正是这一档要支持的配置）。
                ⚠️ 读数那句人话来自 Rust（`mesh::config_state`）—— 界面**不**自己判断
                "别人拉不拉得到"（那要按地址形状判档，而档位只许由 Rust 出，与上面那条同一纪律）。 */}
            {isDesktopPlatform() && lanStatus && !!activeRow?.space_id.trim() && (
              <div className="sync-att sync-mesh">
                <span className="sync-att-text">
                  <span className="sync-att-name">网格（设备之间直接同步）</span>
                  {/* ★ 2026-09-26 口径收敛：**地址不在这里说第二遍** —— 窗口地址与"别人拉不拉得到"
                      已经在上面那一行"局域网直连"里（`lanStatus.mesh.note`）。这一块只管**设置**
                      （监听地址 / 口令）与开关。 */}
                  <span className="sync-hint">
                    {lanStatus.mesh.tokenSet ? "口令：已设" : "口令：未设（同一网段里谁都能拉，内容仍是密文）"}
                  </span>
                  {/* 交换**并进「同步」**，这里不再有自己的按钮（同一件事原本两个按钮、用户要记两个动作）。*/}
                  <span className="sync-hint">开着的空间点「同步」时会**顺手**和同一网段的对端交换一轮。</span>
                </span>
                <div className="sync-field">
                  <input
                    className="sync-input"
                    placeholder="监听地址，如 192.168.1.5:8788"
                    value={meshBind}
                    disabled={meshBusy}
                    onChange={(e) => setMeshBind(e.target.value)}
                  />
                  <button className="sync-btn" disabled={meshBusy || !meshBind.trim()} onClick={() => void saveMeshBind()}>
                    保存地址
                  </button>
                </div>
                <div className="sync-field">
                  <input
                    className="sync-input"
                    placeholder="口令（留空 ＝ 不动已有口令）"
                    value={meshToken}
                    disabled={meshBusy}
                    onChange={(e) => setMeshToken(e.target.value)}
                  />
                  <button className="sync-btn" disabled={meshBusy || !meshToken.trim()} onClick={() => void saveMeshToken()}>
                    设口令
                  </button>
                </div>
                <div className="sync-field">
                  <button className="sync-btn" disabled={meshBusy || !lanStatus.mesh.enabled} onClick={() => void disableMesh()}>
                    关掉网格
                  </button>
                </div>
              </div>
            )}

            {/* C2 网络闸门：只在**真查得到**网络类型的平台上出现（桌面回 "n/a" = 不适用）。
                与其在桌面上显示一个永远不起作用的开关，不如按能力把它收起来。 */}
            {netKind !== "n/a" && (
              <label className="sync-att sync-net">
                <input
                  type="checkbox"
                  checked={budget?.wifi_only ?? true}
                  disabled={budgetBusy}
                  onChange={(e) => budget && void saveBudget({ ...budget, wifi_only: e.target.checked })}
                />
                <span className="sync-att-text">
                  <span className="sync-att-name">只在 Wi-Fi 下自动同步</span>
                  <span className="sync-hint">
                    关掉后蜂窝网络也会自动同步（可能消耗流量）。手动点「同步」始终可用——这条只管自动同步。
                  </span>
                </span>
              </label>
            )}

            {/* C1 预算刹车：磁盘余量下限是**硬性**的（没有"关闭"选项）。 */}
            {budget && (
              <details className="sync-advanced sync-budget">
                <summary>同步预算（磁盘余量 / 单文件上限 / 本次上限）</summary>
                <div className="sync-budget-row">
                  <span className="sync-auto-label">磁盘余量下限</span>
                  <select
                    className="sync-input"
                    value={String(budget.disk_floor_mb)}
                    disabled={budgetBusy}
                    onChange={(e) => void saveBudget({ ...budget, disk_floor_mb: Number(e.target.value) })}
                  >
                    <option value="256">256 MB</option>
                    <option value="512">512 MB</option>
                    <option value="1024">1 GB</option>
                    <option value="2048">2 GB</option>
                    <option value="5120">5 GB</option>
                  </select>
                </div>
                <div className="sync-budget-row">
                  <span className="sync-auto-label">单文件上限</span>
                  <select
                    className="sync-input"
                    value={String(budget.max_file_mb)}
                    disabled={budgetBusy}
                    onChange={(e) => void saveBudget({ ...budget, max_file_mb: Number(e.target.value) })}
                  >
                    <option value="0">不限</option>
                    <option value="50">50 MB</option>
                    <option value="100">100 MB</option>
                    <option value="500">500 MB</option>
                  </select>
                </div>
                <div className="sync-budget-row">
                  <span className="sync-auto-label">本次下载上限</span>
                  <select
                    className="sync-input"
                    value={String(budget.max_run_mb)}
                    disabled={budgetBusy}
                    onChange={(e) => void saveBudget({ ...budget, max_run_mb: Number(e.target.value) })}
                  >
                    <option value="0">只报告，不拦</option>
                    <option value="500">500 MB</option>
                    <option value="1024">1 GB</option>
                    <option value="5120">5 GB</option>
                  </select>
                </div>
                <p className="sync-hint">
                  余量低于下限、或超过单文件上限的附件会停在安全的地方：已经下载的字节全部保留，
                  下次同步接着下（按内容寻址，不会重复下）。磁盘余量下限不可关闭。
                </p>
              </details>
            )}
            {syncing ? (
              <div className={`sync-status is-progress${syncPhase === "error" ? " is-err" : ""}`}>
                <div className="sync-progress-row">
                  <span className="sync-spin" aria-hidden />
                  <span className="sync-status-text">{syncMessage || "正在同步…"}</span>
                  {attTotal > 0 && (
                    <span className="sync-progress-count" title={attName || ""}>
                      {attCurrent}/{attTotal}
                    </span>
                  )}
                </div>
                {syncPhase === "attachments" && attTotal > 0 && (
                  <div className="sync-progressbar">
                    <div
                      className="sync-progressbar-fill"
                      style={{ width: `${(attCurrent / attTotal) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            ) : status ? (
              <div className={`sync-status is-${statusKind(status)}`}>
                {status}
                {syncDurationMs > 0 && (
                  <span className="sync-duration">耗时 {fmtDuration(syncDurationMs)}</span>
                )}
              </div>
            ) : null}
            {history.length > 0 && (
              <div className="sync-history">
                <div className="sync-history-head">
                  <button className="sync-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
                    <span className="sync-history-toggle-title">同步历史</span>
                    <span className="sync-history-count">{history.length}</span>
                    <span className={`sync-history-caret${historyOpen ? " is-open" : ""}`} aria-hidden>▾</span>
                  </button>
                  <button className="sync-history-clear" onClick={() => void clearHistory()} title="清空同步历史">清空</button>
                </div>
                {historyOpen && (
                  <div className="sync-history-list">
                    {history.slice(0, 8).map((h, i) => {
                      const d = new Date(h.at).toLocaleString("zh-CN");
                      const open = detailOpenIdx === i;
                      return (
                        <div key={i} className="sync-history-item">
                          <span className={`sync-history-status${h.ok ? " is-ok" : " is-err"}`}>{h.ok ? "✓" : "✗"}</span>
                          <div className="sync-history-main">
                            <div className="sync-history-title">
                              <span className="sync-history-at" title={d}>{relTime(h.at)}</span>
                              <span className="sync-history-stats">
                                <span className="sync-stat">↑ {h.pushed}</span>
                                <span className="sync-stat">↓ {h.pulled}</span>
                              </span>
                              {h.items.length > 0 && (
                                <button
                                  className="sync-history-detail-toggle"
                                  onClick={() => setDetailOpenIdx(open ? null : i)}
                                >
                                  {h.items.length} 项明细 ▾
                                </button>
                              )}
                            </div>
                            {h.message && <div className="sync-history-msg">{h.message}</div>}
                            {open && (
                              <div className="sync-history-items">
                                {h.items.slice(0, 30).map((it, j) => (
                                  <div key={j} className="sync-history-item-row">
                                    <span className={`sync-dir-${it.dir}`}>{it.dir === "push" ? "↑" : "↓"}</span>
                                    <span className="sync-entity">{entityLabel(it.entity)}</span>
                                    <span className={`sync-op${it.op === "delete" ? " is-del" : ""}`}>{it.op === "delete" ? "删除" : "变更"}</span>
                                    <span className="sync-id" title={it.entity_id}>{it.title || it.entity_id.slice(0, 10)}</span>
                                  </div>
                                ))}
                                {h.items.length > 30 && <div className="sync-history-more">…等 {h.items.length - 30} 项</div>}
                            </div>
                          )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </footer>
        </div>
      )}
    </div>
  );
}


