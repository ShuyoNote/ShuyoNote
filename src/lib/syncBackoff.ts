// 「空闲退避」判据（2026-09-30）：自动同步那一轮的**节拍该不该放长**。
//
// ## 为什么要有它（读数）
//
// 实测（`_workspace/notes/2026-09-30-b1-b2-prechecks-macos.md` §B2.10 ＋
// `2026-09-30-polling-fix-breakdown-macos.md`）：
//   · 一次**空轮询**（拉取什么也没换到）＝ **256 B**（请求 137 ＋ 响应 119 ✓）
//   · 而节拍是 **5 秒**、且**没有退避** ⇒ 每设备每天 **(N−1)×17,280** 次空轮询 ✓
//   · 一个 2 台设备的用户 ≈ **197 MB/月**，其中**约 81% 是空转** ✓
// ⇒ ⇒ 所以"闲着的时候把节拍放长"是**最便宜的一刀**（纯客户端、不动协议、不动 `mesh.rs` ✓）。
//
// ## 三条口径（**判据就在这里，别处不许再解释一遍**）
//
// ① **基础节拍是用户选的**（面板 5 秒／30 秒／1 分钟）——它同时是"活跃时"的节拍 ✓。
//    ⚠️ **我们不改默认值**（owner 2026-09-29 拍过 5 秒 ✓）；这里只让**空闲时**比它更慢。
// ② **退避有硬顶**（`BACKOFF_CAP_MS`，且**不小于**基础节拍）⇒
//    ⭐ 这一条**就是"无条件兜底"**：`threshold` **永远 ≤ cap** ⇒
//    **别人改了东西，最多 `cap` 之后一定被发现** —— 而它**不依赖任何外部提示** ✓
//    （所以不存在"某个提示说没新数据 ⇒ 静默不同步"那个失败模式 ✓）
// ③ **交替方向是 fail-safe 的**：判"这一轮空不空"时，
//    **只有明确换到了东西才算"非空"**；**出错／读不到一律按"空"算** ⇒
//    最坏后果是"多退一点"（放长节拍），**不是"少拉"** ✓

/** 退避硬顶：无论空闲多久，间隔不超过它 ⇒ 这就是"无条件兜底"的时限 ✓ */
export const BACKOFF_CAP_MS = 60_000;

/** 指数上限（防 `2 ** n` 溢出；到这个量级早就顶到 cap 了 ✓） */
const MAX_STREAK_EXP = 20;

export type BackoffInput = {
  /** 现在（毫秒） */
  nowMs: number;
  /** 上一次**真正跑过**（没被跳过、没被闸门拦掉）的时刻；从没跑过 ⇒ `null` */
  lastRunAtMs: number | null;
  /** 面板选的基础节拍（毫秒） */
  baseMs: number;
  /** 连续"这一轮什么都没换到"的次数 */
  emptyStreak: number;
};

export type BackoffDecision = {
  /** 现在该不该跑这一轮 */
  due: boolean;
  /** 距"该跑"还有多久（已到点 ⇒ ≤0） */
  waitMs: number;
  /** 本次用的阈值（＝ min(base × 2^streak, cap)） */
  thresholdMs: number;
  /** 硬顶（＝ max(base, BACKOFF_CAP_MS)） */
  capMs: number;
  /** 一句人话：为什么是这个阈值（界面/日志要说得出口 ✓） */
  reason: string;
};

/**
 * 这一轮该不该跑。
 *
 * ⚠️ **纯函数**（不打桩、不读时钟、不读 localStorage）—— 判据要能逐条钉住 ✓。
 */
export function decideSyncTick(input: BackoffInput): BackoffDecision {
  const baseMs = Number.isFinite(input.baseMs) && input.baseMs > 0 ? input.baseMs : 1;
  // ② 硬顶**不小于**基础节拍：用户选了 1 分钟 ⇒ 不许退避到比它更快，也不许比它更慢 ✓
  const capMs = Math.max(baseMs, BACKOFF_CAP_MS);
  const streakRaw = Number.isFinite(input.emptyStreak) ? input.emptyStreak : 0;
  const streak = Math.max(0, Math.min(Math.trunc(streakRaw), MAX_STREAK_EXP));
  const grown = baseMs * 2 ** streak;
  // ⭐ 这一行就是"无条件兜底"：阈值的上界是 cap ✓
  const thresholdMs = Math.min(grown, capMs);

  const elapsed = input.lastRunAtMs === null ? Number.POSITIVE_INFINITY : input.nowMs - input.lastRunAtMs;
  const due = elapsed >= thresholdMs;

  const reason =
    input.lastRunAtMs === null
      ? "从没跑过 ⇒ 按基础节拍"
      : streak === 0
        ? `活跃 ⇒ 基础节拍 ${baseMs}ms`
        : `连续空转 ${streak} 次 ⇒ ${thresholdMs}ms（上限 ${capMs}ms，到点必跑 ✓）`;

  return { due, waitMs: thresholdMs - elapsed, thresholdMs, capMs, reason };
}

// ─────────────────────── 「切到后台还跑不跑」 ───────────────────────

/**
 * 纯函数：**切到后台时该不该接着按节拍跑**（2026-09-30）。
 *
 * ★ 只停**移动端**，**不停桌面端** —— 这条分寸是本次唯一的坑 ✗：
 *   · **移动端**：系统本来就会冻结进程（iOS 挂起 / Android Doze）⇒
 *     与其"被冻在半路、回来还要再等一个节拍"，不如**显式停**，
 *     并在**回到前台时立刻补一轮**（用户一回来就看到最新的 ✓）。
 *   · **桌面端**：⚠️ **「窗口被挡住 / 最小化」≠「用户走了」** ——
 *     笔记本在别的窗口工作时，**本来就该继续同步** ✓；
 *     拿 `hidden` 一刀切会把桌面一起停掉 ✗（先例：`lib/platform/capabilities.ts` 头注那条
 *     "不许拿近似当能力判断"）。
 *   · 所以判据必须**同时**看 `hidden` **和** `isMobile` —— 只看其中一个都是错的 ✗。
 *
 * @param hidden 当前是不是不可见（`document.visibilityState === "hidden"`）
 * @param isMobile 是不是移动端（同一口径：`isMobileUserAgent`，见 `lib/platform/capabilities.ts`）
 */
export function decideHiddenTick(input: { hidden: boolean; isMobile: boolean }): {
  run: boolean;
  reason: string;
} {
  if (!input.hidden) return { run: true, reason: "在前台 ⇒ 照节拍跑" };
  if (!input.isMobile) {
    return { run: true, reason: "桌面端隐藏 ⇒ 照跑（窗口被挡住 ≠ 用户走了）" };
  }
  return { run: false, reason: "移动端切后台 ⇒ 停（回前台时立刻补一轮）" };
}

// ─────────────────────────── 「这一轮空不空」 ───────────────────────────

/** 服务端同步一侧的**最小形状**（只要 `pulled`；不 import 具体类型，免得判据跟着类型漂 ✓） */
export type SyncLike = { pulled?: number | null } | null | undefined;
/** 网格一侧的**最小形状**（只要每个对端的 `fetched` / `applied`） */
export type MeshLike = {
  peers?: { fetched?: number | null; applied?: number | null }[] | null;
} | null | undefined;

/**
 * 这一轮**有没有换到东西** ⇒ `true` ＝ **活跃**（把退避清零）。
 *
 * ★ 口径（见头注 ③）：**只有明确换到了才算非空** ——
 *   · 服务端档：任一空间 `pulled > 0`（**收进来**的才算；`pushed` 是我自己发的，不算"外面有新东西" ✓）
 *   · 网格档：任一对端 `fetched > 0` **或** `applied > 0`
 *   · 出错 / 读不到 / 空数组 ⇒ **一律算空**（最坏是"多退一点"，不是"少拉" ✓）
 */
export function roundWasEmpty(syncResults: SyncLike[], meshReports: MeshLike[]): boolean {
  // ⭐ **task-12（owner 拍 C）**：整轮跑完了也**留一行** ✓ ——
  //   否则「没触发」（闸门没放行 ✓）与「触发了、跑完了、什么都没换到」**在日志里同形** ✗。
  //   ⚠️ 这一处是**被 App.tsx 已经调到的地方** ✓（⛔ 不改 App.tsx ✗ —— 那是 task-14 的写域 ✗）。
  //   ⚠️ 加了这一行之后本函数**不再是纯函数**（多了一次日志 ✓）—— 所以"拼那一行"那一半
  //      抽成了纯函数 [`autoSyncRoundLine`] ✓，判据打在它上面 ✓。
  console.info(autoSyncRoundLine(syncResults, meshReports));
  for (const r of syncResults ?? []) {
    const pulled = r?.pulled;
    if (typeof pulled === "number" && pulled > 0) return false;
  }
  for (const m of meshReports ?? []) {
    for (const p of m?.peers ?? []) {
      const fetched = p?.fetched;
      const applied = p?.applied;
      if (typeof fetched === "number" && fetched > 0) return false;
      if (typeof applied === "number" && applied > 0) return false;
    }
  }
  return true;
}

/**
 * ⭐ **task-12（owner 拍 C）**：那一轮**跑完了**的人话 —— **纯函数**（判据够得着 ✓，与
 * `syncGate.autoSyncGateLine` 同一形状 ✓）。
 *
 * 三样都在：**服务端那条跑了几个空间** ✓（`syncResults` 长度）、**网格那条几个空间/几台对端/收下几条** ✓、
 * 于是「触发了并跑完」与「没触发」「被闸门挡下」**分得开** ✓（后两件由 [`autoSyncGateLine`] 负责 ✓）。
 */
export function autoSyncRoundLine(syncResults: SyncLike[], meshReports: MeshLike[]): string {
  const server = (syncResults ?? []).length;
  const serverPulled = (syncResults ?? []).reduce(
    (a, r) => a + (typeof r?.pulled === "number" ? r.pulled : 0),
    0,
  );
  const meshSpaces = (meshReports ?? []).length;
  let peers = 0;
  let got = 0;
  for (const m of meshReports ?? []) {
    for (const p of m?.peers ?? []) {
      peers += 1;
      if (typeof p?.fetched === "number") got += p.fetched;
    }
  }
  return (
    `[sync] 自动同步这一轮**跑完了**：服务端 ${server} 个空间（收下 ${serverPulled}）` +
    `｜ 网格 ${meshSpaces} 个空间、${peers} 台对端（收下 ${got}）`
  );
}
