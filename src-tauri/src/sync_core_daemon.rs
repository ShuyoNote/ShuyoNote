//! ⭐ **P3-1b 第三小步（task-61）**：`--sync-core-daemon` 无头 daemon ＋ **单写者锁（带角色）**。
//!
//! ## 锁文件格式（向后兼容）
//! ```text
//! <pid>
//! role=app|daemon      ← 可选；老锁（只有 pid）仍可读
//! ```
//! * 老格式（仅 pid）⇒ `role: None`（unknown，⛔ 不猜）；
//! * App 抢锁写 `role=app`；daemon 写 `role=daemon`；
//! * `Drop` 仍只删"pid 还是自己"的那份（⛔ 不误删别人的锁）；死 pid/坏内容 ⇒ 回收。
//!
//! ## App 被 daemon 占锁时的安全路径（本笔新增）
//! 1. 读锁信息；只有 **role=daemon 且 pid 活着** 才提示"停止 daemon 并继续启动 App？"（Yes/No）；
//! 2. **用户确认 Yes 之后**才允许 `kill -TERM`（Unix）；⛔ role=app/unknown/死 pid 一律**不杀**；
//! 3. 终止后 ≤5s 轮询 pid/锁 → 重新按 `role=app` 抢锁；成功继续启动，失败可读退出；
//! 4. Windows 本笔不做进程管理：明确提示"请手动停止 daemon"（⛔ 不假装能停）。
//!
//! ## 默认行为
//! 没有 `--sync-core-daemon` 时本模块只被 `is_daemon_flag` 纯判断碰到一次；⛔ 不建锁/不建 DB。
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

/// ⭐ **锁的持有者角色**（写进锁文件第二行；老锁没有这一行 ⇒ unknown）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockRole {
    App,
    Daemon,
}

impl LockRole {
    pub fn as_str(self) -> &'static str {
        match self {
            LockRole::App => "app",
            LockRole::Daemon => "daemon",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "app" => Some(LockRole::App),
            "daemon" => Some(LockRole::Daemon),
            _ => None, // ⛔ 不认识的角色不猜
        }
    }
}

/// 锁文件解析结果（老格式只有 pid ⇒ `role=None`）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LockInfo {
    pub pid: Option<u32>,
    pub role: Option<LockRole>,
}

/// ⭐ 纯函数：锁文件内容 → `LockInfo`（第一行 pid；可选 `role=...`）。
///
/// 兼容：只有 pid 的老锁 ⇒ `role=None`；坏内容 ⇒ 对应字段 None（⛔ 不虚构）。
pub fn parse_lock_info(text: &str) -> LockInfo {
    let mut lines = text.lines();
    let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    let role = lines.find_map(|l| l.trim().strip_prefix("role=").and_then(LockRole::parse));
    LockInfo { pid, role }
}

/// ⭐ 纯函数：锁文件内容 → pid（旧 API，保留兼容；老判据在用）。
pub fn parse_lock_pid(text: &str) -> Option<u32> {
    parse_lock_info(text).pid
}

/// 读锁文件的 `LockInfo`（文件不存在/读不到 ⇒ 默认值；不报错——调用方本来就在失败路径上）。
pub fn read_lock_info(path: &Path) -> LockInfo {
    parse_lock_info(&std::fs::read_to_string(path).unwrap_or_default())
}

/// ⭐ **可复用入口（App 与 daemon 共用）**：按 app data 目录抢同一把单写者锁（带角色）。
pub fn acquire_in(app_data_dir: &Path, role: LockRole) -> Result<SingleWriterLock, String> {
    SingleWriterLock::acquire_with_role(&lock_path(app_data_dir), Some(role))
}

/// 这个 pid 还活着吗（unix：`kill -0`；非 unix：保守当作活着 ⇒ 拒绝抢锁）。
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(true); // 连 kill 都没有 ⇒ 保守当作活着
        if !alive {
            return false;
        }
        // ⚠️ 僵尸进程：`kill -0` 仍成功，但它已经死了（只是父进程还没 reap）⇒ **算死**。
        //   真实 daemon 被 TERM 后也可能短暂处于这个状态（取决于它的父进程）；
        //   不让"等 5 秒超时"被这个假活读数拖住（DB 锁本来也已经随进程死了）。
        if let Ok(out) = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
        {
            let stat = String::from_utf8_lossy(&out.stdout);
            if stat.trim_start().starts_with('Z') {
                return false;
            }
        }
        true
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
    role: Option<LockRole>,
}

impl SingleWriterLock {
    /// ⭐ 抢锁（老格式：只写 pid ⇒ role unknown；判据/兼容用）。
    pub fn acquire(path: &Path) -> Result<Self, String> {
        Self::acquire_with_role(path, None)
    }

    /// ⭐ 抢锁并写角色（App=app / daemon=daemon）。
    pub fn acquire_with_role(path: &Path, role: Option<LockRole>) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建锁目录失败：{e}"))?;
        }
        if let Some(err) = try_create(path, role)? {
            return Err(err);
        }
        Ok(SingleWriterLock {
            path: path.to_path_buf(),
            pid: std::process::id(),
            role,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn role(&self) -> Option<LockRole> {
        self.role
    }
}

/// `Ok(None)` ＝ 抢到了；`Ok(Some(reason))` ＝ 已有活进程；`Err` ＝ IO 失败（不是"别人占着"）。
fn try_create(path: &Path, role: Option<LockRole>) -> Result<Option<String>, String> {
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut f) => {
                let _ = write!(f, "{}", std::process::id());
                if let Some(role) = role {
                    let _ = write!(f, "\nrole={}", role.as_str());
                }
                let _ = f.flush();
                return Ok(None);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let info = read_lock_info(path);
                let alive = info.pid.map(pid_alive).unwrap_or(false);
                if alive {
                    let holder = info.pid.unwrap_or(0);
                    let msg = match info.role {
                        Some(LockRole::Daemon) => format!(
                            "另一个 sync_core daemon 已在运行（pid={holder}；锁：{}）⇒ 本进程退出（单写者锁）",
                            path.display()
                        ),
                        Some(LockRole::App) => format!(
                            "另一个 ShuyoNote 实例正在使用数据目录（pid={holder}；锁：{}）⇒ 本进程退出（单写者锁）",
                            path.display()
                        ),
                        None => format!(
                            "另一个进程正在使用数据目录（pid={holder}，角色未知；锁：{}）⇒ 本进程退出（单写者锁）",
                            path.display()
                        ),
                    };
                    return Ok(Some(msg));
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

/// ⭐ **App 被占锁时的决策**（纯函数，判据直接喂 `LockInfo`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockBlockedAction {
    /// only role=daemon 且 pid 活着 ⇒ 可以**问用户**要不要停止它（⛔ 还要 user_confirmed 才能 kill）。
    OfferStopDaemon,
    /// app/unknown/死 pid/坏信息 ⇒ **不杀**，直接可读报错退出。
    Fail,
}

/// ⭐ 决策表：只有"role=daemon ＋ pid 活着"才给"停止 daemon 并继续"的选项。
pub fn blocked_action(info: &LockInfo) -> LockBlockedAction {
    match (info.role, info.pid.map(pid_alive)) {
        (Some(LockRole::Daemon), Some(true)) => LockBlockedAction::OfferStopDaemon,
        _ => LockBlockedAction::Fail,
    }
}

/// ⭐ **终止授权**（纯函数）：必须同时满足 `user_confirmed` ＋ role=daemon ＋ pid 活着。
/// ⛔ app/unknown/死 pid/未确认 ⇒ 一律 false（**不杀未知进程**）。
pub fn terminate_allowed(info: &LockInfo, user_confirmed: bool) -> bool {
    user_confirmed && matches!(blocked_action(info), LockBlockedAction::OfferStopDaemon)
}

/// 等 daemon 退出的最长时间（≤5s，任务口径）。
pub const DAEMON_STOP_WAIT_MS: u64 = 5_000;

/// ⭐ **用户确认后**：`kill -TERM` daemon，等 ≤5s，然后按 `role=app` 重新抢锁。
///
/// ⚠️ **安全边界**（调用方必须是"用户已确认"那一支）：
/// * 只接受 **role=daemon** 的锁（杀前**重新读文件**校验，防竞态/旧信息）；
/// * pid 必须与锁里一致且活着；⛔ 不杀 app/unknown/死 pid；
/// * Windows：本版不做进程管理，**明确报错**（⛔ 不假装能停）；
/// * 等 pid 退出后靠 `acquire_in(role=app)` 重新抢（死 pid 的残余锁会自动回收）。
pub fn stop_daemon_and_retry(app_data_dir: &Path, pid: u32) -> Result<SingleWriterLock, String> {
    let path = lock_path(app_data_dir);
    let info = read_lock_info(&path);
    if !terminate_allowed(&info, true) {
        return Err(format!(
            "拒绝终止：锁里是 {:?}（pid={:?}），不是活着的 sync_core daemon",
            info.role, info.pid
        ));
    }
    if info.pid != Some(pid) {
        return Err(format!(
            "拒绝终止：锁里的 pid={:?} 与要停的 pid={pid} 不一致（可能已被别人换过）",
            info.pid
        ));
    }
    #[cfg(unix)]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| format!("发送 TERM 失败：{e}"))?;
        if !status.success() {
            return Err(format!("发送 TERM 失败（kill 退出码 {status:?}）"));
        }
    }
    #[cfg(not(unix))]
    {
        return Err("这个平台不支持自动停止 sync_core daemon：请手动停止它后重开 App".to_string());
    }
    // 等 pid 退出（≤5s），然后重抢锁。
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(DAEMON_STOP_WAIT_MS);
    loop {
        if !pid_alive(pid) {
            return acquire_in(app_data_dir, LockRole::App);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "已发送 TERM，但 daemon（pid={pid}）在 {}ms 内没退出 ⇒ 请手动处理",
                DAEMON_STOP_WAIT_MS
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// ⭐ App 启动抢锁的**唯一入口**（失败路径里才弹框/终止；成功返回持有到进程退出的锁）。
///
/// 安全顺序：读锁信息 ⇒ 只有 `blocked_action == OfferStopDaemon` 才弹**确认** ⇒
/// **用户 Yes 之后**才 `stop_daemon_and_retry`；app/unknown/死 pid ⇒ 只报错退出。
pub fn acquire_for_app_or_exit(
    app: &tauri::App,
    app_data_dir: &Path,
) -> Result<SingleWriterLock, i32> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    match acquire_in(app_data_dir, LockRole::App) {
        Ok(lock) => Ok(lock),
        Err(first_err) => {
            let info = read_lock_info(&lock_path(app_data_dir));
            if matches!(blocked_action(&info), LockBlockedAction::OfferStopDaemon) {
                let pid = info.pid.unwrap_or(0);
                let confirmed = app
                    .dialog()
                    .message(format!(
                        "sync_core daemon 正在运行（pid={pid}）。\n\n停止它并继续启动 ShuyoNote？\n（停止后 daemon 会退出；本机同步会由 App 接管。）"
                    ))
                    .title("ShuyoNote 启动")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "停止 daemon 并继续".to_string(),
                        "取消".to_string(),
                    ))
                    .blocking_show();
                if confirmed {
                    match stop_daemon_and_retry(app_data_dir, pid) {
                        Ok(lock) => return Ok(lock),
                        Err(e) => {
                            eprintln!("[single-writer] 停止 daemon 后仍起不来：{e}");
                            let _ = app
                                .dialog()
                                .message(format!("停止 daemon 失败：\n{e}"))
                                .title("ShuyoNote 无法启动")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                            return Err(1);
                        }
                    }
                }
                eprintln!("[single-writer] 用户选择取消（不停止 daemon）⇒ 退出");
                return Err(1);
            }
            // app/unknown/死 pid：**不杀**，只可读报错。
            eprintln!("[single-writer] {first_err}");
            let _ = app
                .dialog()
                .message(format!(
                    "ShuyoNote 的数据目录正被另一个进程使用：\n{first_err}"
                ))
                .title("ShuyoNote 无法启动")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            Err(1)
        }
    }
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
    let _lock = match acquire_in(&app_data_dir, LockRole::Daemon) {
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
        assert!(
            err.contains("另一个进程") || err.contains("另一个 sync_core daemon"),
            "{err}"
        );
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
        let daemon = acquire_in(&dir, LockRole::Daemon).expect("daemon 应当先拿到锁");
        assert!(lock_path(&dir).is_file());
        // App（同一入口 acquire_in）⇒ 可读失败（含持有 pid 与路径）。
        let err = match acquire_in(&dir, LockRole::App) {
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
        let again = acquire_in(&dir, LockRole::App).expect("释放后必须能再拿");
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
            .find("sync_core_daemon::acquire_for_app_or_exit(app, &app_data_dir)")
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
        // 失败路径：lib 里 exit(code) ＋ setup 返回 Err（不继续 restore/init DB）；
        // 用户对话框/停 daemon 的安全逻辑在 daemon 模块（另一条源码级判据钉住）。
        let failure = &setup[lock_at..init_at];
        assert!(
            failure.contains("app.handle().exit(code)"),
            "失败必须退出非 0"
        );
        assert!(
            failure.contains("return Err("),
            "setup 失败必须返回 Err（⛔ 不继续落库）"
        );
        assert!(
            failure.contains("acquire_for_app_or_exit"),
            "失败路径必须走可复用入口（内部含 role 判定/确认框）"
        );
        // 成功路径：锁交给 app 管理到进程退出（不再手动 drop）。
        let success = &setup[lock_at..restore_at];
        assert!(
            success.contains("app.manage(db_lock)"),
            "App 必须把锁托管到 app（进程退出才 Drop）"
        );
        assert!(!success.contains("drop(db_lock)"), "⛔ 不许提前释放锁");
    }

    // ── ⭐ task-61：锁角色 / 决策表 / 只在确认后终止 ─────────────────────────────

    #[test]
    fn lock_role_round_trips_and_old_pid_only_locks_still_parse() {
        let dir = temp_dir("role");
        let lock = acquire_in(&dir, LockRole::Daemon).expect("daemon 抢锁");
        let text = std::fs::read_to_string(lock_path(&dir)).unwrap();
        let info = parse_lock_info(&text);
        assert_eq!(info.pid, Some(std::process::id()));
        assert_eq!(
            info.role,
            Some(LockRole::Daemon),
            "daemon 必须写 role=daemon"
        );
        assert!(text.contains("role=daemon"), "{text}");
        drop(lock);

        let app = acquire_in(&dir, LockRole::App).expect("app 抢锁");
        assert_eq!(
            read_lock_info(&lock_path(&dir)).role,
            Some(LockRole::App),
            "App 必须写 role=app"
        );
        drop(app);

        // 老格式（只有 pid）⇒ 仍可读，role 未知（⛔ 不猜）。
        let legacy = parse_lock_info("12345");
        assert_eq!(legacy.pid, Some(12345));
        assert_eq!(legacy.role, None);
        let legacy2 = parse_lock_info("12345\n");
        assert_eq!(legacy2.role, None);
        // role 拼写不合法 ⇒ 未知（⛔ 当 app/daemon）。
        assert_eq!(parse_lock_info("1\nrole=wat").role, None);
        assert_eq!(
            parse_lock_info("1\n role=Daemon ").role,
            Some(LockRole::Daemon),
            "大小写/空白容忍"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocked_action_offers_stopping_only_a_live_daemon() {
        let live = std::process::id();
        assert_eq!(
            blocked_action(&LockInfo {
                pid: Some(live),
                role: Some(LockRole::Daemon)
            }),
            LockBlockedAction::OfferStopDaemon
        );
        for info in [
            LockInfo {
                pid: Some(live),
                role: Some(LockRole::App),
            },
            LockInfo {
                pid: Some(live),
                role: None,
            },
            LockInfo {
                pid: Some(999_999_999),
                role: Some(LockRole::Daemon),
            },
            LockInfo {
                pid: None,
                role: Some(LockRole::Daemon),
            },
        ] {
            assert_eq!(
                blocked_action(&info),
                LockBlockedAction::Fail,
                "不该提供停止选项：{info:?}"
            );
        }
        // 终止授权：必须"用户确认 ＋ daemon ＋ 活着"三者齐备。
        let daemon = LockInfo {
            pid: Some(live),
            role: Some(LockRole::Daemon),
        };
        assert!(terminate_allowed(&daemon, true));
        assert!(!terminate_allowed(&daemon, false), "⛔ 没确认不许杀");
        assert!(!terminate_allowed(
            &LockInfo {
                pid: Some(live),
                role: Some(LockRole::App)
            },
            true
        ));
        assert!(!terminate_allowed(
            &LockInfo {
                pid: Some(live),
                role: None
            },
            true
        ));
        assert!(!terminate_allowed(
            &LockInfo {
                pid: Some(999_999_999),
                role: Some(LockRole::Daemon)
            },
            true
        ));
    }

    /// 源码级安全边界：只有"role=daemon ＋ 用户确认"才走终止；app/unknown 不杀；
    /// 杀前重新校验 role/pid。
    #[test]
    fn the_kill_path_is_reachable_only_after_confirmation_and_role_check() {
        let me = include_str!("sync_core_daemon.rs");
        let app_entry = me
            .split("pub fn acquire_for_app_or_exit(")
            .nth(1)
            .expect("acquire_for_app_or_exit 必须在");
        // ① 先读锁信息、只有 OfferStopDaemon 才弹确认。
        assert!(app_entry.contains("read_lock_info(&lock_path(app_data_dir))"));
        assert!(app_entry
            .contains("matches!(blocked_action(&info), LockBlockedAction::OfferStopDaemon)"));
        // ② 对话框结果必须被接住，且 **Yes 之后**才终止。
        let confirm_at = app_entry
            .find(".blocking_show()")
            .expect("必须有确认对话框");
        let stop_at = app_entry
            .find("stop_daemon_and_retry(app_data_dir, pid)")
            .expect("必须调终止入口");
        assert!(confirm_at < stop_at, "⛔ 必须先弹确认框，再终止 daemon");
        assert!(
            app_entry[confirm_at..stop_at].contains("if confirmed"),
            "⛔ 终止必须在用户确认（confirmed）分支里"
        );
        // ③ 终止函数自己再校验：只收 role=daemon/pid 活着（防竞态/旧信息）。
        let stop_fn = me
            .split("pub fn stop_daemon_and_retry(")
            .nth(1)
            .expect("stop_daemon_and_retry 必须在");
        let check_at = stop_fn
            .find("if !terminate_allowed(&info, true)")
            .expect("杀前必须重新校验 terminate_allowed");
        let kill_at = stop_fn.find("\"-TERM\"").expect("unix 用 TERM");
        assert!(check_at < kill_at, "⛔ 必须先校验 role/pid 再发 TERM");
        assert!(
            stop_fn.contains("info.pid != Some(pid)"),
            "pid 不一致必须拒绝"
        );
        // ④ Windows 明确报错（不假装能停）。
        assert!(stop_fn.contains("这个平台不支持自动停止 sync_core daemon"));
        // ⑤ app/unknown 分支里不许出现 stop/kill。
        let fail_branch = app_entry
            .split("// app/unknown/死 pid")
            .nth(1)
            .expect("必须有 app/unknown 不杀分支");
        assert!(!fail_branch.contains("stop_daemon_and_retry("));
        assert!(!fail_branch.contains("\"-TERM\""));
    }

    /// 真终止：起一个 `sleep` 子进程模拟 daemon，写 role=daemon 的锁；确认后 TERM 它并重抢锁。
    #[cfg(unix)]
    #[test]
    fn confirmed_stop_of_a_live_daemon_terminates_it_and_reacquires_the_lock() {
        let dir = temp_dir("stop-daemon");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("起 sleep 子进程");
        let child_pid = child.id();
        std::fs::write(lock_path(&dir), format!("{child_pid}\nrole=daemon\n")).unwrap();
        let lock = stop_daemon_and_retry(&dir, child_pid).expect("确认后应当停掉 daemon 并拿到锁");
        assert_eq!(
            read_lock_info(&lock_path(&dir)).role,
            Some(LockRole::App),
            "重抢后写的是 App 角色"
        );
        let status = child.wait().expect("等 sleep 退出");
        assert!(!status.success(), "sleep 应当被 TERM 终止（{status:?}）");
        drop(lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refusing_to_stop_an_app_or_unknown_holder_never_signals_it() {
        let dir = temp_dir("refuse-stop");
        // 写"App 占锁"（pid 用本进程）⇒ 调用终止入口必须拒绝，且本进程必须还活着。
        std::fs::write(
            lock_path(&dir),
            format!("{}\nrole=app\n", std::process::id()),
        )
        .unwrap();
        let err = stop_daemon_and_retry(&dir, std::process::id()).expect_err("不许杀 App");
        assert!(err.contains("拒绝终止"), "{err}");
        assert!(
            pid_alive(std::process::id()),
            "本进程当然还活着（⛔ 没被 TERM）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 源码级：App 先锁后 restore/db::init（与 task-60 一致）；失败 exit 非 0。
    #[test]
    fn the_app_lock_still_precedes_restore_and_db_init() {
        let lib = include_str!("lib.rs");
        let setup = &lib[lib.find(".setup(|app| {").expect("setup")..];
        let lock_at = setup
            .find("sync_core_daemon::acquire_for_app_or_exit(app, &app_data_dir)")
            .expect("App 必须走可复用入口");
        let restore_at = setup.find("apply_staged_restore").expect("restore");
        let init_at = setup.find("let conn = db::init(").expect("db::init");
        assert!(lock_at < restore_at && lock_at < init_at);
        assert!(setup[lock_at..init_at].contains("app.handle().exit(code)"));
    }
}
