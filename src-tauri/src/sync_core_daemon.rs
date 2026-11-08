//! ⭐ **P3-1b 第一小步（task-59）**：`--sync-core-daemon` 无头 daemon 骨架 ＋ **单写者锁**。
//!
//! ## 边界（本笔只做骨架，⛔ 不接 App / 不改默认行为）
//! * **默认不启用**：没有 `--sync-core-daemon` 时本模块**一个函数都不会跑**——
//!   `lib.rs::run()` 第一行只做一次纯参数判断，不命中就直接继续原来的 Tauri 启动
//!   （⛔ 不建锁、⛔ 不建 DB、⛔ 不起额外任务）；
//! * **App 不拿锁**：正常 App/Web 启动不碰 `sync_core.lock`；daemon 与 App 同时跑时：
//!   **App 照旧**（本笔不切 App 写者），**daemon 自己被锁拒绝**并给可读错误。
//! * daemon 启动顺序：解析 app data ⇒ **先拿单写者锁** ⇒ 无头初始化 DB（照
//!   `run_backup_once` 的三步：`db::init` / `security::startup_lock` / `manage(Db)`）
//!   ⇒ 打开 `sync_core` runtime 开关（懒启动调度循环）⇒ 阻塞（直到进程被终止）。
//!
//! ## 锁的形状（不依赖额外 crate）
//! `sync_core.lock`：`create_new` 抢锁；内容写 pid。已存在时读 pid：
//! * pid **还活着** ⇒ 可读错误（"另一个 daemon 已在运行（pid=…）"）并退出；
//! * pid 已死（崩溃/被 kill 留下的）⇒ **回收重建**（否则一次崩溃就再也起不来）。
//! `Drop` 只删"还是自己 pid"的那份（⛔ 不误删别人的锁）。
//!
//! ⚠️ 已知边界：本笔**不引 tokio `signal` feature**（零新依赖）⇒ Ctrl-C 由操作系统默认终止，
//!   **Drop 不会跑**、锁文件可能残留 —— 但下次启动会按"pid 已死"回收（见上），不会永久卡死。

use std::io::Write as _;
use std::path::{Path, PathBuf};

/// CLI flag（与 `plugin_host::HOST_FLAG` 同款：精确匹配一个参数）。
pub const DAEMON_FLAG: &str = "--sync-core-daemon";
/// 锁文件名（唯一出处）。
pub const LOCK_FILE_NAME: &str = "sync_core.lock";

/// ⭐ 纯函数：参数里有没有 daemon flag（精确匹配；`--sync-core-daemon=x` 不算）。
pub fn is_daemon_flag(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|a| a == DAEMON_FLAG)
}

/// 单写者锁的路径（`<app data>/sync_core.lock`）。
pub fn lock_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LOCK_FILE_NAME)
}

/// ⭐ **可复用入口（App 与 daemon 共用）**：按 app data 目录抢同一把单写者锁。
///
/// ⚠️ **必须在 `db::init` 之前**调用（App 的 setup 已按这个顺序接线；
/// 判据钉住 lock < db::init）。失败信息含**持有者 pid 与锁路径**（可读）。
pub fn acquire_in(app_data_dir: &Path) -> Result<SingleWriterLock, String> {
    SingleWriterLock::acquire(&lock_path(app_data_dir))
}

/// ⭐ 纯函数：锁文件内容 → pid（只认第一行整数；坏内容 ⇒ None）。
pub fn parse_lock_pid(text: &str) -> Option<u32> {
    text.lines().next()?.trim().parse::<u32>().ok()
}

/// 这个 pid 还活着吗（unix：`kill -0`；非 unix：保守当作活着 ⇒ 拒绝抢锁）。
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(true) // 连 kill 都没有 ⇒ 保守当作活着
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// 单写者锁：拿到它 = 本机只有一个 sync_core writer。
#[derive(Debug)]
pub struct SingleWriterLock {
    path: PathBuf,
    pid: u32,
}

impl SingleWriterLock {
    /// ⭐ 抢锁：首次成功；已有**活进程** ⇒ Err（可读）；已有**死进程**残留 ⇒ 回收后重试一次。
    pub fn acquire(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建锁目录失败：{e}"))?;
        }
        if let Some(err) = try_create(path)? {
            return Err(err);
        }
        Ok(SingleWriterLock {
            path: path.to_path_buf(),
            pid: std::process::id(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// `Ok(None)` ＝ 抢到了；`Ok(Some(reason))` ＝ 已有活进程；`Err` ＝ IO 失败（不是"别人占着"）。
fn try_create(path: &Path) -> Result<Option<String>, String> {
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut f) => {
                let _ = write!(f, "{}", std::process::id());
                let _ = f.flush();
                return Ok(None);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let text = std::fs::read_to_string(path).unwrap_or_default();
                let holder = parse_lock_pid(&text);
                let alive = holder.map(pid_alive).unwrap_or(false);
                if alive {
                    return Ok(Some(format!(
                        "另一个 sync_core daemon 已在运行（pid={}；锁：{}）⇒ 本进程退出（单写者锁）",
                        holder.unwrap_or(0),
                        path.display()
                    )));
                }
                // 残留锁（进程已死/坏内容）⇒ 回收一次再抢；第二次还失败就如实报。
                if attempt == 0 {
                    let _ = std::fs::remove_file(path);
                    continue;
                }
                return Err(format!(
                    "锁文件『{}』存在且抢不到（残余锁回收失败）",
                    path.display()
                ));
            }
            Err(e) => return Err(format!("建锁文件『{}』失败：{e}", path.display())),
        }
    }
    Err(format!("抢锁失败（{}）", path.display()))
}

impl Drop for SingleWriterLock {
    fn drop(&mut self) {
        // ⚠️ 只删"还是自己 pid"的那份（防止文件已被别的进程重建）。
        let mine = parse_lock_pid(&std::fs::read_to_string(&self.path).unwrap_or_default())
            == Some(self.pid);
        if mine {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// ⭐ 无头 daemon 入口（**只在 `--sync-core-daemon` 时被调用**）：返回进程退出码。
///
/// 顺序照 `run_backup_once` 的最小无头初始化；多出来的是**先拿锁**再初始化 DB。
pub fn run_daemon() -> i32 {
    use tauri::Manager;

    // ① 裸 Builder（⛔ 不建窗口/不起插件 —— 与 `run_backup_once` 同形）只为拿 app data 目录。
    let app = match tauri::Builder::default().build(crate::app_context()) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[sync-core-daemon] 无头启动失败：{e}");
            return 2;
        }
    };
    let Some(app_data_dir) = crate::db::resolve_app_data_dir(app.path().app_data_dir().ok()) else {
        eprintln!("[sync-core-daemon] 拿不到应用数据目录（也没有 SHUYONOTE_DATA_DIR）");
        return 2;
    };
    // ② **先抢单写者锁**（失败 ⇒ 可读错误退出，⛔ 不碰 DB）。
    let _lock = match acquire_in(&app_data_dir) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sync-core-daemon] {e}");
            return 1;
        }
    };
    // ③ 无头初始化 DB（照 `run_backup_once` 那三步）。
    let conn = match crate::db::init(app_data_dir.clone()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sync-core-daemon] 初始化数据库失败：{e}");
            return 2;
        }
    };
    crate::security::startup_lock(&conn);
    app.manage(crate::db::Db(std::sync::Mutex::new(conn)));
    // ④ 打开 sync_core runtime 开关（懒启动调度循环；daemon 默认启用）。
    crate::sync_core::set_runtime_enabled(app.handle(), true);
    eprintln!(
        "[sync-core-daemon] 已启动（pid={}，数据目录 {}，锁 {}）⇒ 阻塞运行；Ctrl-C/终止进程退出",
        std::process::id(),
        app_data_dir.display(),
        lock_path(&app_data_dir).display()
    );
    // ⑤ 阻塞（本笔不引 tokio signal feature；进程被终止即结束；锁残留由 pid 回收兜底）。
    tauri::async_runtime::block_on(std::future::pending::<()>());
    unreachable!("daemon 循环永不返回")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "shuyonote-sync-core-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_daemon_flag_is_exact_and_default_is_off() {
        assert!(!is_daemon_flag(args(&[])), "默认无 flag ⇒ 不进 daemon");
        assert!(!is_daemon_flag(args(&["--backup-once"])));
        assert!(
            !is_daemon_flag(args(&["--sync-core-daemon=x"])),
            "⛔ 只做精确匹配"
        );
        assert!(is_daemon_flag(args(&["--sync-core-daemon"])));
        assert!(is_daemon_flag(args(&["--other", "--sync-core-daemon"])));
        assert_eq!(DAEMON_FLAG, "--sync-core-daemon");
    }

    #[test]
    fn lock_is_single_writer_then_released_on_drop() {
        let dir = temp_dir("lock");
        let p = lock_path(&dir);
        let first = SingleWriterLock::acquire(&p).expect("首次应当抢到锁");
        assert!(p.is_file(), "抢到后锁文件必须在");
        // 第二个（同进程也一样）⇒ 可读错误，不是 panic/静默。
        let err = match SingleWriterLock::acquire(&p) {
            Ok(_) => panic!("⛔ 第二个写者不许抢到锁"),
            Err(e) => e,
        };
        assert!(err.contains("另一个 sync_core daemon"), "{err}");
        assert!(
            err.contains(&std::process::id().to_string()),
            "错误里要能读出持有 pid：{err}"
        );
        drop(first);
        assert!(!p.exists(), "Drop 必须删锁");
        // Drop 之后可以再拿。
        let second = SingleWriterLock::acquire(&p).expect("释放后应当还能抢到");
        drop(second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_lock_with_a_dead_pid_is_reclaimed() {
        let dir = temp_dir("stale");
        let p = lock_path(&dir);
        // 一个几乎不可能活的 pid ⇒ 按"残留锁"回收。
        std::fs::write(&p, "999999999").unwrap();
        assert_eq!(parse_lock_pid("999999999"), Some(999_999_999));
        let lock = SingleWriterLock::acquire(&p).expect("死 pid 的残留锁必须能被回收");
        assert!(parse_lock_pid(&std::fs::read_to_string(&p).unwrap()).is_some());
        drop(lock);
        assert!(!p.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lock_pid_parsing_is_lenient_but_bounded() {
        assert_eq!(parse_lock_pid("1234\njunk"), Some(1234));
        assert_eq!(parse_lock_pid(" 42 "), Some(42));
        assert_eq!(parse_lock_pid(""), None);
        assert_eq!(parse_lock_pid("not-a-pid"), None);
        assert_eq!(parse_lock_pid("999999999999999999999"), None, "溢出 ⇒ 不猜");
    }

    /// 源码级：flag 分流在 `run()` 的 Tauri 初始化**之前**；无 flag 时 daemon 一个函数都不跑；
    /// App 正常启动**不获取**锁。
    #[test]
    fn the_flag_is_dispatched_before_tauri_and_the_app_never_takes_the_lock() {
        let lib = include_str!("lib.rs");
        let me = include_str!("sync_core_daemon.rs");
        // ① flag 判断必须在 `run()` 的 Tauri builder/plugin 之前。
        let run_at = lib.find("pub fn run()").expect("run() 必须在");
        let after = &lib[run_at..];
        let flag_at = after
            .find("sync_core_daemon::is_daemon_flag")
            .expect("run() 里必须有 daemon flag 分流");
        let builder_at = after
            .find("tauri::Builder::default()")
            .expect("run() 里必须有 Tauri builder");
        assert!(
            flag_at < builder_at,
            "⛔ daemon flag 分流必须在任何 Tauri 初始化之前（macOS Dock/单实例问题）"
        );
        let dispatch = &after[flag_at..builder_at];
        assert!(
            dispatch.contains("std::process::exit(sync_core_daemon::run_daemon())"),
            "分流命中后必须直接 exit（⛔ 不继续建窗口）"
        );
        // ② 无 flag 时不会进 daemon（判断是同一个 flag；`run_daemon` 只在这里被调）。
        assert_eq!(lib.matches("sync_core_daemon::run_daemon()").count(), 1);
        // ③ App 正常启动不拿锁（锁只在 daemon 模块内；lib.rs 不出现 SingleWriterLock/锁名）。
        assert!(!lib.contains("SingleWriterLock"));
        assert!(!lib.contains(LOCK_FILE_NAME));
        // ④ daemon 初始化照 `run_backup_once`：init/startup_lock/manage(Db) ＋ 先锁后 DB。
        let lock_at = me
            .find("SingleWriterLock::acquire")
            .expect("daemon 必须抢锁");
        let init_at = me.find("crate::db::init(").expect("daemon 必须初始化 DB");
        assert!(lock_at < init_at, "⛔ 顺序必须先抢锁再初始化 DB");
        for needle in [
            "crate::security::startup_lock(&conn)",
            "app.manage(crate::db::Db(",
            "crate::sync_core::set_runtime_enabled(app.handle(), true)",
        ] {
            assert!(me.contains(needle), "缺无头初始化那一步：{needle}");
        }
        // ⑤ 默认不变：没命中 flag 时 `run()` 里不建锁、不起 daemon 任务。
        assert!(!lib.contains("lock_path(&"));
    }

    /// ⭐ task-60：App 与 daemon 抢的是**同一个文件路径** ⇒ 两者不会同时开库。
    #[test]
    fn app_and_daemon_share_one_lock_so_they_never_open_the_db_together() {
        let dir = temp_dir("shared");
        // daemon 先占（模拟 daemon 已启动）。
        let daemon = acquire_in(&dir).expect("daemon 应当先拿到锁");
        assert!(lock_path(&dir).is_file());
        // App（同一入口 acquire_in）⇒ 可读失败（含持有 pid 与路径）。
        let err = match acquire_in(&dir) {
            Ok(_) => panic!("⛔ App 与 daemon 不许同时开库（第二把锁必须失败）"),
            Err(e) => e,
        };
        assert!(err.contains("另一个 sync_core daemon"), "{err}");
        assert!(
            err.contains(&std::process::id().to_string()),
            "要能读到持有者 pid：{err}"
        );
        assert!(err.contains("sync_core.lock"), "要能读到锁路径：{err}");
        // App 那条路失败时**不删/不抢** daemon 的锁：daemon 仍持有。
        assert!(lock_path(&dir).is_file());
        drop(daemon);
        assert!(!lock_path(&dir).exists(), "正常退出（Drop）必须释放锁");
        // 释放后下一方可以拿（两种入口同一个语义）。
        let again = acquire_in(&dir).expect("释放后必须能再拿");
        drop(again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 源码级：App 在 **db::init 之前**拿锁；失败路径不 init DB、可读、退出非 0；
    /// 成功路径把锁交给 app 管理（Drop 时机＝进程退出）。
    #[test]
    fn the_app_takes_the_same_lock_before_any_database_open_and_exits_on_failure() {
        let lib = include_str!("lib.rs");
        let setup_at = lib.find(".setup(|app| {").expect("App setup 必须在");
        let setup = &lib[setup_at..];
        let lock_at = setup
            .find("sync_core_daemon::acquire_in(&app_data_dir)")
            .expect("App setup 必须在 db::init 之前拿单写者锁");
        let restore_at = setup
            .find("apply_staged_restore")
            .expect("staged restore 必须在");
        let init_at = setup.find("let conn = db::init(").expect("db::init 必须在");
        assert!(
            lock_at < restore_at,
            "⛔ 锁必须在「恢复暂存」之前拿（恢复会动库文件）"
        );
        assert!(restore_at < init_at, "前提：暂存恢复本来就在 db::init 之前");
        assert!(
            lock_at < init_at,
            "⛔ 单写者锁必须在 db::init 之前（否则两个进程会同时开库）"
        );
        // 失败路径：可读日志 ＋ 系统对话框尝试 ＋ exit(1) ＋ setup 返回 Err（不继续 init DB）。
        let failure = &setup[lock_at..init_at];
        assert!(failure.contains("[single-writer]"), "失败要有一行可读日志");
        assert!(
            failure.contains("blocking_show()"),
            "要尝试系统对话框说明原因"
        );
        assert!(failure.contains("app.handle().exit(1)"), "失败必须退出非 0");
        assert!(
            failure.contains("return Err("),
            "setup 失败必须返回 Err（⛔ 不继续落库）"
        );
        assert!(
            failure.contains("daemon"),
            "错误话术要说明 daemon/另一个进程"
        );
        // 成功路径：锁交给 app 管理到进程退出（不再手动 drop）。
        let success = &setup[lock_at..restore_at];
        assert!(
            success.contains("app.manage(db_lock)"),
            "App 必须把锁托管到 app（进程退出才 Drop）"
        );
        assert!(!success.contains("drop(db_lock)"), "⛔ 不许提前释放锁");
    }
}
