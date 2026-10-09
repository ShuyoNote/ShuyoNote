// check-headless-backup —— 无头备份（`--backup-once`）的**接线**还在不在。
//
// ── 为什么有它（2026-10-09 真实事故，两处，都是我踩的）────────────────────────────
// ① ⭐ 「接上了但出不了包」✗：`main.rs` 的分流 ＋ `lib.rs` 的入口都写好了、编译也过、进程也
//    自己退了、**窗口数也是 0** ✓ —— 但 ⭐ **包数 ＝ 0** ✗。真因：无头路径用的是**裸 Builder**
//    ⇒ 它不带 `run()` 那条链（插件 ＋ `.setup()`）⇒ ⭐ `Db` 没人托管 ✓ ⇒ 跑一次等于跳过。
//    ⚠️ 而症状是 ⭐ **静默的**：没有报错、没有 panic（只有一行"数据库 5 秒内没就绪"）✓。
// ② ⭐ 「八天没生效」同族：本项目有过"补丁只覆盖 dev 构建、产品版从没生效"的先例
//    （见 `check-editor-table-gesture.mjs` 的头注释）⇒ ⭐ 接线类的东西**必须有静态判据** ✓。
//
// ⚠️ 本门禁**不**跑 Rust、**不**起进程（那是 `rust` 组/artifact 组的活）：
//    它只做**源码级**接线核对 —— 快、任何机器都能跑、而且恰好挡住上面那两处的"被人删掉"。
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => (existsSync(resolve(root, p)) ? readFileSync(resolve(root, p), "utf8") : null);
const problems = [];
const ok = [];

/** ⭐ 必须出现的**逐字**片段（⭐ 用逐字片段而不是正则 ⇒ 判据一眼能核 ✓） */
function must(file, needle, why) {
  const text = read(file);
  if (text === null) {
    problems.push(`${file} 不存在（${why}）`);
    return;
  }
  if (!text.includes(needle)) {
    problems.push(`${file} 里找不到：${needle}  ← ${why}`);
    return;
  }
  ok.push(`${file}：有 \`${needle}\``);
}

// ① 分流：`main.rs` 必须在 `shuyonote_lib::run()` **之前**判 `--backup-once`
must("src-tauri/src/main.rs", "--backup-once", "无头开关的名字（⭐ 与 systemd 单元里那条必须一致 ✓）");
must("src-tauri/src/main.rs", "run_backup_once", "⚠️ 少了它 ⇒ ⭐ `--backup-once` 会**照旧开窗口** ✗");
must("src-tauri/src/main.rs", "CliMode::BackupOnce", "分流判据本身");
{
  const m = read("src-tauri/src/main.rs") ?? "";
  const atBranch = m.indexOf("CliMode::BackupOnce");
  const atRun = m.indexOf("shuyonote_lib::run()");
  if (atBranch >= 0 && atRun >= 0 && atBranch > atRun) {
    problems.push("src-tauri/src/main.rs：⭐ 分流写在 `run()` **之后** ✗ ⇒ 永远轮不到它 ✓");
  }
}

// ② 入口：`lib.rs` 里那个函数 ＋ ⭐ **那三步**（缺任何一步 ⇒ 出不了包 ✓）
must("src-tauri/src/lib.rs", "pub fn run_backup_once", "无头入口");
must("src-tauri/src/lib.rs", "db::init(", "⚠️ 无头路径必须自己把库开起来（⭐ 裸 Builder 不带 setup ✓）");
must("src-tauri/src/lib.rs", "security::startup_lock(", "与 `setup()` 同口径（⭐ 加密空间默认锁着 ✓）");
must("src-tauri/src/lib.rs", "app.manage(Db(", "⭐ **最关键的一步**：不托管 `Db` ⇒ 无头只会**静默跳过** ✗");
must("src-tauri/src/lib.rs", "pub mod auto_backup;", "⭐ 私有 `mod` ⇒ `main.rs` 用不到（编译 E0603 ✓）");

// ③ 跑一次的实现 ＋ ⭐ 目标目录（⭐ 出包落在哪 ✓）
must("src-tauri/src/backup.rs", "pub async fn run_auto_backup_once", "无头跑一次的实现");
must("src-tauri/src/backup.rs", '.join("backups")', "⭐ 出包目录（⭐ 判据读的就是它 ✓）");
must("src-tauri/src/backup.rs", ".zip.part", "⭐ 先写 `.part` ⇒ 成功才改名（⭐ 免得留半个包 ✓）");

// ④ systemd 单元文本：⭐ 三平台里 Linux 那半的关键字（⭐ 少了就装不起来/不会补跑 ✓）
must("src-tauri/src/auto_backup.rs", "Type=oneshot", "⭐ 跑完就退（⛔ 不是常驻 ✗）");
must("src-tauri/src/auto_backup.rs", "OnUnitActiveSec=", "⭐ 间隔（⭐ 默认 24h ✓）");
must("src-tauri/src/auto_backup.rs", "Persistent=true", "⭐ 关机错过的要补跑 ✓");
must("src-tauri/src/auto_backup.rs", "WantedBy=timers.target", "⭐ 装到哪一档 ✓");

// ⑤ 调度器 ＋ 保留分层的常量（⭐ 文档 §5 逐字：启动触发 ＋ 每 24h ／ 7 日·4 周·12 月 ✓）
must("src-tauri/src/auto_backup.rs", "DEFAULT_INTERVAL_SECS", "启动触发 ＋ 每 24h 的间隔");
must("src-tauri/src/auto_backup.rs", "KEEP_DAYS", "保留分层：7 日");
must("src-tauri/src/auto_backup.rs", "KEEP_WEEKS", "保留分层：4 周");
must("src-tauri/src/auto_backup.rs", "KEEP_MONTHS", "保留分层：12 月");

if (problems.length > 0) {
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(`\n✗ check-headless-backup：${problems.length} 处接线缺失（⭐ 这些缺失都是**静默**的 ⇒ 只能静态挡 ✓）`);
  process.exit(1);
}
console.log(`✅ check-headless-backup：${ok.length} 处接线都在`);
console.log("   ⭐ 覆盖：main.rs 分流在 run() 之前 ✓ ／ lib.rs 无头入口 ＋ 托管 Db 那三步 ✓");
console.log("   ⭐      ／ backup.rs 出包到 backups/ ＋ 先写 .part ✓ ／ systemd 单元四要素 ✓ ／ 调度与保留常量 ✓");
process.exit(0);
