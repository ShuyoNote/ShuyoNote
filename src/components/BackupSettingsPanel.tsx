// **设置中心「数据」页：自动备份那一格**（task-19）—— 目标是"**它在跑，但用户看不见**" ⇒ "用户看得见" ✓。
//
// ## ⭐ 这一格的**诚实底线**（这一笔最容易犯、也最该被机器挡住的错）
// 后端 `auto_backup.rs` ＋ `backup.rs::run_auto_backup_once` ＋ `lib.rs:513-530` 的调度**都在、真的在跑** ✓；
// ⛔ 但它**没有**两样东西 ⇒ 界面**如实说**，⛔ 不画：
//   · **没有开关**（只有"启动先跑一轮 ＋ 每 24h 轮询"✓）⇒ 界面写「随应用启动自动跑一轮…」，
//     ⛔ 不摆那个假控件 ✗（判据 c 挡着 ✓，方向是双向的：后端将来真加了开关，它也会红 ⇒ 提醒补界面 ✓）
//   · **没有"立刻备份一次"的命令**（`run_auto_backup_once` 是 `backup.rs` 里的**普通函数**，没开成命令 ✓）
//     ⇒ ⛔ 不摆一个点了没用的按钮 ✗，而是**如实写清现在怎么才能立刻备一份**（重启应用／无头 `--backup-once` ✓）
//
// ## ⚠️ 为什么"上次备份时刻／份数／大小"现在显示**读不到**
// 实测（2026-10-10）：`commands.ts` 里与备份有关的命令**只有** `export_backup`（手动导出到用户选的路径 ✗）
// 与 `import_backup` ✗ ⇒ ⛔ **没有**任何命令能给出"自动备份的状态／上次时刻／backups 目录里有几份" ✗。
// ⇒ 本面板把 `facts` 传 `null` ＋ 一句**原因** ✓（⛔ 不显示 0 份装作"没有备份" ✗ —— 判据 b 挡着 ✓）；
//   要真显示，缺的是后端那 **1 条只读命令**（见文件末尾的"缺什么"注释 ✓）。
//
// ## 复用，⛔ 不重写
// 手动「导出完整备份／导入备份」仍然是 `BackupButton.tsx` 那一份实现 ✓（本面板**渲染它** ✓，
// ⛔ 自己不调 `exportBackup`/`importBackup` ✗ —— 判据 d 挡着 ✓）。

import { useState } from "react";

import { BackupButton } from "./BackupButton";

/**
 * ⭐ **保留策略／间隔**：数字**照后端常量说**（⛔ 不许自己写一个数 ✗），
 * 并由判据 e 直接读 `src-tauri/src/auto_backup.rs` **逐字比对** ✓（改后端不改这里 ⇒ 红 ✓）。
 * 出处：`KEEP_DAYS=7` ／ `KEEP_WEEKS=4` ／ `KEEP_MONTHS=12` ／ `DEFAULT_INTERVAL_SECS=24*60*60` ✓。
 */
export const BACKUP_RETENTION = {
  keepDays: 7,
  keepWeeks: 4,
  keepMonths: 12,
  intervalSecs: 86_400,
} as const;

/** 后端能给的读数（⭐ 现在后端给不了 ⇒ 传 `null` ⇒ 如实说"读不到" ✓）。 */
export interface BackupFacts {
  /** 上次**成功**备份的时刻（Unix 秒）；读不到 ⇒ `null` ✓ */
  lastSuccessUnix: number | null;
  /** 现在有几份；读不到 ⇒ `null` ✓ */
  count: number | null;
  /** 共多大（字节）；读不到 ⇒ `null` ✓ */
  bytes: number | null;
  /** 备份目录（后端未开放绝对路径 ⇒ `null` ⇒ 只说平台约定 ✓） */
  dir: string | null;
  /** 为什么读不到（一句人话 ⇒ 显示给用户 ✓；`null` ＝ 读数都在 ✓） */
  unreadableReason: string | null;
}

/** 后端**还没有**的那条读数的原因（⭐ 一句话、不装 ✓）。 */
export const BACKUP_READINGS_UNAVAILABLE =
  "后端还没有开放这条读数（缺一条只读命令：列出 backups/ 里的快照 ＋ 上次成功时刻）";

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
      : "备份目录：应用数据目录下的 `backups/`（绝对路径后端未开放 ⇒ 只写平台约定 ✓）",
  );
  lines.push(
    `保留策略（照后端 ${"`retention_keep`"} ✓）：${BACKUP_RETENTION.keepDays} 天内**每天留 1 份** ／ ` +
      `${BACKUP_RETENTION.keepWeeks} 周内**每周留 1 份** ／ ${BACKUP_RETENTION.keepMonths} 个月内**每月留 1 份** ／ 更早的删除`,
  );
  lines.push(
    "触发方式：**随应用启动先跑一轮**，之后每 24 小时再看一次（本机后端**没有**「开／关」这个能力 ⇒ 这里不摆那个假控件）",
  );
  return lines;
}

/**
 * 设置中心「数据」页的那一格（自包含 ⇒ Lead 一行就能挂 ✓，或由 `BackupButton` 带 `label` 时挂 ✓）。
 */
export function BackupSettingsPanel() {
  const [showMissing, setShowMissing] = useState(false);
  // ⚠️ 现在**只能**传 `null`：没有命令能给这些读数 ✗（见文件头"为什么显示读不到" ✓）
  const facts: BackupFacts | null = null;
  const lines = backupFactsLines(facts);

  return (
    <div className="backup-auto" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
      <div className="backup-auto-title" style={{ fontWeight: 600 }}>
        自动备份
      </div>
      <ul className="backup-auto-facts" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="backup-auto-manual" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>手动那条路（导出／导入备份）仍在这里：</span>
        {/* ⭐ 复用既有实现 ⇒ ⛔ 不写第二份备份逻辑 ✓（判据 d 挡着 ✓）。
            ⚠️⚠️ **故意不传 `label`**：`BackupButton` 在有 `label` 时会挂**本面板** ⇒
               带 label 会**无限自我嵌套** ✗（判据 d 里有一条专门挡这个 ✓）*/}
        <BackupButton />
      </div>
      <button
        className="set-btn"
        style={{ alignSelf: "flex-start", fontSize: 12 }}
        onClick={() => setShowMissing((v) => !v)}
      >
        {showMissing ? "收起：现在怎么才能立刻备一份" : "现在怎么才能**立刻**备一份？"}
      </button>
      {showMissing && (
        <div className="backup-auto-howto" style={{ fontSize: 12, lineHeight: 1.7, opacity: 0.9 }}>
          ⛔ 后端**还没有**「立刻备份一次」的命令（`run_auto_backup_once` 是 `backup.rs` 里的普通函数，
          没开成命令 ⇒ 界面不摆一个点了没用的按钮）⇒ 现在要立刻备一份，只有两条真路：
          <br />· **重启应用**：启动时会先跑一轮（`lib.rs:513` 的"启动触发"✓）；
          <br />· **无头模式**：`ShuyoNote.exe --backup-once`（跑一次就退出 ⛔ 不建窗口 ✓，P3 已接 ✓）。
          <br />补上界面的那一条要后端加 **1 条写命令**（`#[tauri::command] run_auto_backup_once` ＋
          `lib.rs` 登记 ＋ `commands.ts` 声明 ＋ Web 侧 stub）—— 那不在这一笔的写域里 ✓。
        </div>
      )}
    </div>
  );
}
