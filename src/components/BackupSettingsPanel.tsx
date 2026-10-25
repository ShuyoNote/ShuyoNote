// **设置中心「数据」页：自动备份那一格**（task-19 接界面 ＋ task-20 补后端两条命令）。
//
// ## 这一格现在是什么（task-20 之后）
// 后端把**已有的**自动备份能力开成了两条命令 ⇒ 这里显示**真读数** ✓、并且能**立刻备一次** ✓：
//   · 读：`auto_backup_status`（`src-tauri/src/backup.rs`）⇒ 目录／份数／共多大／上次成功时刻／保留窗口 ✓
//   · 写：`auto_backup_run_now` ⇒ ⭐ **直接走既有的 `run_auto_backup_once`**（⛔ 不重写备份逻辑 ✗）
//
// ## ⭐ 这一格的诚实底线（三条，都有判据挡着）
// ① ⛔ **不画假开关**：后端**没有**"开／关"这个能力（只有"启动先跑一轮 ＋ 每 24h 轮询"✓）
//    ⇒ 界面写清触发方式，⛔ 不摆那个假控件 ✗（判据 c；而且**反向**：后端真加了开关能力它会红 ✓）
// ② ⛔ **不把"读不到"显示成"0 份"**：`unreadable`（目录读不了／拿不到数据目录）⇒ **如实说"读不到"** ✓；
//    而目录**只是不存在**（还没备份过）⇒ 那是**真的 0 份**，照实显示 ✓（判据 b：两种"没有"要分清 ✓）
// ③ ⛔ **保留窗口不写第二遍**：优先用后端给的 `keepDays/keepWeeks/keepMonths` ✓；
//    界面里那份 `BACKUP_RETENTION` 只作**兜底**（且被判据 e 钉着与 `auto_backup.rs` 常量逐字一致 ✓）
//
// ## 复用，⛔ 不重写
// 手动「导出完整备份／导入备份」的唯一入口在 `SettingsDialog` 那一行（`<BackupButton label=… />` ✓）。
// ⭐ 2026-10-11：本面板**不再渲染** `<BackupButton />` ✗ —— 那会变成**第二个入口**（owner 截图问出来的 ✓）；
// 本面板自己也⛔ 不调 `exportBackup`/`importBackup` ✗（⛔ 不写第二份实现 ✓，判据 d 钉着 ✓）。

import { useEffect, useState } from "react";

import { platform } from "../lib/platform";
import { toast } from "../store/toast";

/** ⭐ task-20 ①：只读读数（三处同名：这里 ↔ `backup.rs` ↔ `lib.rs` 的登记，判据 g 钉着 ✓）。 */
export const AUTO_BACKUP_STATUS_COMMAND = "auto_backup_status";
/** ⭐ task-20 ②：立刻备份一次（判据 j 钉着 ✓）。 */
export const AUTO_BACKUP_RUN_COMMAND = "auto_backup_run_now";

/**
 * ⭐ **保留策略／间隔的兜底**：数字**照后端常量说**（⛔ 不许自己写一个数 ✗），
 * 并由判据 e 直接读 `src-tauri/src/auto_backup.rs` **逐字比对** ✓（改后端不改这里 ⇒ 红 ✓）。
 * ⚠️ 运行时**优先用后端给的窗口**（`facts.windows` ✓）—— 这一份只在"读数取不到"时兜底显示 ✓。
 */
export const BACKUP_RETENTION = {
  keepDays: 7,
  keepWeeks: 4,
  keepMonths: 12,
  intervalSecs: 86_400,
} as const;

/** `auto_backup_status` 的返回（与 `commands.ts` 的声明同形 ✓）。 */
export interface AutoBackupStatusPayload {
  dir: string;
  count: number;
  bytes: number;
  lastSuccessUnix: number | null;
  snapshots: Array<{ name: string; unix: number; size: number }>;
  keepDays: number;
  keepWeeks: number;
  keepMonths: number;
  unreadable: string | null;
}

/** `auto_backup_run_now` 的返回 ✓。 */
export interface AutoBackupRunPayload {
  ran: boolean;
  kept: number;
  removed: number;
  note: string;
}

/** 后端能给的读数（⭐ 取不到 ⇒ `unreadableReason` 有话 ⇒ 如实说"读不到" ✓）。 */
export interface BackupFacts {
  /** 上次**成功**备份的时刻（Unix 秒）；读不到 ⇒ `null` ✓ */
  lastSuccessUnix: number | null;
  /** 现在有几份；读不到 ⇒ `null` ✓ */
  count: number | null;
  /** 共多大（字节）；读不到 ⇒ `null` ✓ */
  bytes: number | null;
  /** 备份目录（后端未给 ⇒ `null` ⇒ 只说平台约定 ✓） */
  dir: string | null;
  /** 一句人话：为什么读不到（`null` ＝ 读数都在 ✓） */
  unreadableReason: string | null;
  /** ⭐ 后端给的保留窗口（有就**优先用** ✓；⛔ 界面不写第二遍 ✗） */
  windows?: { keepDays: number; keepWeeks: number; keepMonths: number } | null;
}

/** 读数取不到时的兜底原因（⭐ 一句话、不装 ✓）。 */
export const BACKUP_READINGS_UNAVAILABLE = "后端还没给出这条读数（`auto_backup_status` 没返回内容）";

/**
 * ⭐ **命令返回 ⇒ 界面事实**（纯函数 ⇒ 判据 h/i 直接测它 ✓，不用起真宿主 ✓）。
 * ⚠️ 两种"没有"**必须分开**：`failureReason`／`unreadable` ⇒ **读不到** ✓；
 *    目录不存在（`unreadable: null` ＋ `count: 0`）⇒ **真的 0 份** ✓（照实显示 ✓）。
 */
export function factsFromStatus(
  status: AutoBackupStatusPayload | null,
  failureReason?: string | null,
): BackupFacts {
  const reason = failureReason ?? status?.unreadable ?? null;
  if (!status || reason) {
    return {
      lastSuccessUnix: null,
      count: null,
      bytes: null,
      dir: status?.dir || null,
      unreadableReason: reason || BACKUP_READINGS_UNAVAILABLE,
    };
  }
  return {
    lastSuccessUnix: status.lastSuccessUnix,
    count: status.count,
    bytes: status.bytes,
    dir: status.dir || null,
    unreadableReason: null,
    windows:
      status.keepDays > 0
        ? { keepDays: status.keepDays, keepWeeks: status.keepWeeks, keepMonths: status.keepMonths }
        : null,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Unix 秒 ⇒ `YYYY-MM-DD HH:mm`（本地时区 ✓；⛔ 不引库、不用 toLocale* ⇒ 可断言 ✓）。 */
export function formatUnixLocal(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 字节 ⇒ 人看的（⛔ 不四舍五入成 0 ⇒ 小到看不见就写 `<0.1 MB` ✓）。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * ⭐ **纯函数**：把读数变成给人看的几行（判据 a/b/c 直接测它 ✓ ⇒ 不起真宿主也能验"如实 ✓／读不到 ✓"）。
 * ⛔ 这里**不许**出现"开关"那类措辞（后端没有那个能力 ✓ —— 判据 c 会红 ✓）。
 */
export function backupFactsLines(facts: BackupFacts | null): string[] {
  const lines: string[] = [];
  const reason = facts?.unreadableReason ?? BACKUP_READINGS_UNAVAILABLE;
  const unreadable = !facts || facts.unreadableReason !== null;

  if (unreadable) {
    lines.push(`上次成功备份：读不到（${reason}）`);
    lines.push("现在有几份 ／ 共多大：读不到");
  } else {
    lines.push(
      facts!.lastSuccessUnix === null
        ? "上次成功备份：读不到"
        : `上次成功备份：${formatUnixLocal(facts!.lastSuccessUnix)}`,
    );
    lines.push(facts!.count === null ? "现在有几份：读不到" : `现在有几份：${facts!.count} 份`);
    lines.push(facts!.bytes === null ? "共多大：读不到" : `共多大：${formatBytes(facts!.bytes)}`);
  }
  lines.push(
    facts?.dir
      ? `备份目录：${facts.dir}`
      : "备份目录：应用数据目录下的 `backups/`（绝对路径后端未给出 ⇒ 只写平台约定 ✓）",
  );
  // ⭐ 窗口**优先用后端给的**（`facts.windows`）；取不到才回落到界面那份兜底（判据 i ✓）
  const w = facts?.windows ?? BACKUP_RETENTION;
  lines.push(
    `保留策略（照后端「retention_keep」✓）：${w.keepDays} 天内每天留 1 份 ／ ` +
      `${w.keepWeeks} 周内每周留 1 份 ／ ${w.keepMonths} 个月内每月留 1 份 ／ 更早的删除`,
  );
  lines.push(
    // ⚠️⭐ **2026-10-11（owner 截图「去掉这部分文案」）**：原来这句后面还挂着
    //    「（本机后端没有「开／关」这个能力 ⇒ 这里不摆那个假控件）」✗ —— ⭐ 那是**给我们自己看的理由**
    //    （解释"为什么这里没有开关" ✓）⇒ ⭐ **用户面不该有内部理由** ✗ ⇒ 删掉 ✓。
    //    ⚠️ 那条理由本身**仍然成立**（后端确实没有开／关 ⇒ ⛔ 不许画一个假开关 ✗）——
    //       只是它该留在**代码注释**里，⛔ 不摆在界面上 ✓。
    "触发方式：随应用启动先跑一轮，之后每 24 小时再看一次",
  );
  return lines;
}

/**
 * 设置中心「数据」页的那一格（自包含 ⇒ Lead 一行就能挂 ✓，或由 `BackupButton` 带 `label` 时挂 ✓）。
 */
export function BackupSettingsPanel() {
  const [facts, setFacts] = useState<BackupFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<AutoBackupRunPayload | null>(null);

  /** 取一次读数（⭐ 取不到 ⇒ **如实**映射成"读不到" ✓，⛔ 不回落到 0 份 ✗）。 */
  const refresh = async (): Promise<void> => {
    try {
      const status = await platform.executor.invoke<AutoBackupStatusPayload>(AUTO_BACKUP_STATUS_COMMAND);
      setFacts(factsFromStatus(status, null));
    } catch (e) {
      setFacts(factsFromStatus(null, `取读数失败：${e instanceof Error ? e.message : String(e)}`));
    }
  };

  // ⭐ 挂载时取一次（hooks 顺序：useState ×3 ＋ useEffect 紧随其后 ✓，⛔ 没有早退越过 hooks ✗）
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** ⭐ **立刻备份一次**：只调那条命令（⛔ 不在这里写任何备份逻辑 ✗），跑完**刷新读数** ✓。 */
  const runNow = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setLastRun(null);
    try {
      const r = await platform.executor.invoke<AutoBackupRunPayload>(AUTO_BACKUP_RUN_COMMAND);
      setLastRun(r);
      if (r.ran) {
        toast(`已备份一份（保留 ${r.kept} 份，删除 ${r.removed} 份）`, "success");
      } else {
        // ⭐ 跳过／失败都**照实说**（⛔ 不假装成功 ✗）
        toast(`没备份：${r.note}`, "error");
      }
      await refresh(); // ⇒ 份数真的 +1（判据 d 想要的就是这个形状 ✓）
    } catch (e) {
      toast(`立刻备份失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const unreadable = !facts || facts.unreadableReason !== null;
  const w = facts?.windows ?? BACKUP_RETENTION;
  const dir = facts?.dir ?? null;
  const openDir = async () => {
    if (!dir) return;
    try {
      await platform.opener.openPath(dir);
    } catch (e) {
      toast(`打开备份目录失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  return (
    <div className="backup-auto-card">
      <div className="backup-auto-head">
        <div className="backup-auto-title">自动备份</div>
        <div className="backup-auto-badge">
          {unreadable ? "读数不可用" : `${facts?.count ?? 0} 份 · ${facts?.bytes != null ? formatBytes(facts.bytes) : "—"}`}
        </div>
      </div>

      {unreadable ? (
        <div className="backup-auto-unreadable">
          <div>上次成功备份：读不到</div>
          <div>现在有几份 ／ 共多大：读不到</div>
          <div className="backup-auto-note">{facts?.unreadableReason ?? BACKUP_READINGS_UNAVAILABLE}</div>
        </div>
      ) : (
        <div className="backup-auto-grid">
          <div className="backup-auto-item">
            <span>上次成功备份</span>
            <b>{facts!.lastSuccessUnix === null ? "读不到" : formatUnixLocal(facts!.lastSuccessUnix)}</b>
          </div>
          <div className="backup-auto-item">
            <span>现在有几份</span>
            <b>{facts!.count === null ? "读不到" : `${facts!.count} 份`}</b>
          </div>
          <div className="backup-auto-item">
            <span>共多大</span>
            <b>{facts!.bytes === null ? "读不到" : formatBytes(facts!.bytes)}</b>
          </div>
        </div>
      )}

      <div className="backup-dir-row">
        <span className="backup-dir-label">备份目录</span>
        <code className="backup-dir-path" title={dir ?? undefined}>
          {dir ?? "应用数据目录下的 backups/"}
        </code>
        <button className="set-btn" onClick={() => void openDir()} disabled={!dir}>打开…</button>
      </div>

      <div className="backup-auto-note">
        保留策略：{w.keepDays} 天内每天留 1 份 ／ {w.keepWeeks} 周内每周留 1 份 ／ {w.keepMonths} 个月内每月留 1 份 ／ 更早的删除
      </div>
      <div className="backup-auto-note">触发方式：随应用启动先跑一轮，之后每 24 小时再看一次</div>

      <div className="backup-auto-actions">
        <button className="set-btn" onClick={() => void runNow()} disabled={busy}>
          {busy ? "正在备份…" : "立即备份一次"}
        </button>
        <button className="set-btn" onClick={() => void refresh()} disabled={busy}>刷新读数</button>
      </div>

      {lastRun && (
        <div className="backup-auto-lastrun">
          {lastRun.ran
            ? `刚跑完：保留 ${lastRun.kept} 份 ／ 删除 ${lastRun.removed} 份 —— ${lastRun.note}`
            : `没跑成：${lastRun.note}`}
          {lastRun.ran && (
            <div className="backup-auto-lastrun-hint">
              保留策略是「同一天只留最新一份」⇒ 刚跑完份数可能不变：那说明旧那份被换掉了 —— 看上面「上次成功备份」的时刻有没有往前动。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
