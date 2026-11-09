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
    #[cfg(windows)]
    {
        // ⭐ 2026-11-09（真机实测）：原先非 unix 一律 `true`（"保守当作活着"）⇒ **强杀/崩溃后
        //   `sync_core.lock` 里的死 pid 永远被当成活人**，应用**再也打不开**（真机现场：
        //   `另一个 ShuyoNote 实例正在使用数据目录（pid=23148）`，而 23148 已经不存在）。
        //   现在用 Win32 查真实存活：能打开句柄且退出码仍是 `STILL_ACTIVE` ⇒ 活；否则 ⇒ 死（可回收）。
        //   ⚠️ `OpenProcess` 失败按**死**处理（锁持有者与本进程同用户，正常不会拒；打不开更可能是
        //   进程已退出）。查退出码失败 ⇒ 保守当作活（宁可不回收，也不抢活人的锁）。
        use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            let _ = CloseHandle(handle);
            if ok == 0 {
                return true;
            }
            code == STILL_ACTIVE
        }
    }
    #[cfg(not(any(unix, windows)))]
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

/// ⭐ **用户确认后**：**优先 IPC 优雅停止**，失败/超时才回退 `kill -TERM`，等 ≤5s 重抢锁。
///
/// ⚠️ **安全边界**（调用方必须是"用户已确认"那一支）：
/// * 只接受 **role=daemon** 的锁（停止前**重新读文件**校验，防竞态/旧信息）；
/// * pid 必须与锁里一致且活着；⛔ 不杀 app/unknown/死 pid；
/// * **IPC 优先**：读 endpoint → 回环 `POST /shutdown`（短超时）→ 轮询锁/pid；IPC 成功
///   但 `IPC_SHUTDOWN_GRACE_MS` 内没退出/失败 ⇒ 才 TERM 兜底；
/// * Windows 没有 TERM ⇒ IPC 是唯一自动路（失败则明确报"请手动停止"）；
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
    // ① **IPC 优先**：daemon 自己提供的 /shutdown（带 token、只回环；旧版 daemon 没有该路由 ⇒ 失败）。
    let ipc_requested = match read_endpoint(&endpoint_path(app_data_dir)) {
        Ok(ep) => {
            let ok = shutdown_via_ipc(&ep);
            if ok {
                eprintln!("[single-writer] 已通过 IPC 请求 daemon 优雅退出（pid={pid}）");
            }
            ok
        }
        Err(_) => false,
    };
    if !ipc_requested && !cfg!(unix) {
        return Err(
            "这个平台不支持自动停止 sync_core daemon（IPC 不可用）：请手动停止它后重开 App"
                .to_string(),
        );
    }
    let start = std::time::Instant::now();
    let deadline = start + std::time::Duration::from_millis(DAEMON_STOP_WAIT_MS);
    let mut termed = false;
    loop {
        if !pid_alive(pid) {
            return acquire_in(app_data_dir, LockRole::App);
        }
        let elapsed = start.elapsed().as_millis() as u64;
        // ② IPC 已请求 ⇒ 给它一个短宽限；没请求/超过宽限 ⇒ TERM 兜底。
        let grace_over = !ipc_requested || elapsed >= IPC_SHUTDOWN_GRACE_MS;
        if !termed && grace_over {
            #[cfg(unix)]
            {
                send_term(pid)?;
                termed = true;
                eprintln!("[single-writer] IPC 未在宽限内让 daemon 退出 ⇒ 回退 TERM（pid={pid}）");
            }
            #[cfg(not(unix))]
            {
                return Err(format!(
                    "IPC 停止 daemon（pid={pid}）没在 {}ms 内生效；这个平台没有 TERM 兜底 ⇒ 请手动停止",
                    IPC_SHUTDOWN_GRACE_MS
                ));
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "已尝试 IPC/TERM，但 daemon（pid={pid}）在 {}ms 内没退出 ⇒ 请手动处理",
                DAEMON_STOP_WAIT_MS
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// 发 TERM（unix）；错误可读（⛔ 不含 token）。
#[cfg(unix)]
fn send_term(pid: u32) -> Result<(), String> {
    let status = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|e| format!("发送 TERM 失败：{e}"))?;
    if !status.success() {
        return Err(format!("发送 TERM 失败（kill 退出码 {status:?}）"));
    }
    Ok(())
}

/// 回环 `POST /shutdown`（短超时；HTTP 2xx＝已受理）。⛔ 不打印/不返回 token。
fn shutdown_via_ipc(ep: &SyncCoreEndpoint) -> bool {
    let url = format!("http://127.0.0.1:{}/shutdown", ep.port);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(IPC_STATUS_TIMEOUT_MS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = tauri::async_runtime::block_on(
        client
            .post(&url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", ep.token),
            )
            .send(),
    );
    matches!(resp, Ok(r) if r.status().is_success())
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
    // ③.5 ⭐ task-63：**IPC**（锁 → DB → IPC → 调度器 的顺序）。起不来**只记日志**，
    //     不影响 daemon 主循环（App 侧查询会降级为 reachable=false）。
    let _ipc = match tauri::async_runtime::block_on(start_ipc(app.handle().clone())) {
        Ok((port, guard)) => {
            eprintln!(
                "[sync-core-daemon] 回环 IPC 已启动（127.0.0.1:{port}；endpoint 文件 0600；token 不打印）"
            );
            Some(guard)
        }
        Err(e) => {
            eprintln!("[sync-core-daemon] IPC 起不来（不影响主循环，App 查询会降级）：{e}");
            None
        }
    };
    // ④ 打开 sync_core runtime 开关（懒启动调度循环；daemon 默认启用）。
    crate::sync_core::set_runtime_enabled(app.handle(), true);
    eprintln!(
        "[sync-core-daemon] 已启动（pid={}，数据目录 {}，锁 {}）⇒ 阻塞运行；Ctrl-C/终止进程退出",
        std::process::id(),
        app_data_dir.display(),
        lock_path(&app_data_dir).display()
    );
    // ⑤ 阻塞直到 **shutdown Notify**（`POST /shutdown` 触发；Ctrl-C 仍由 OS 终止兜底）。
    //   ⚠️ Notify 有 permit 语义 ⇒ 即使通知早于这一行到达也不会丢。
    tauri::async_runtime::block_on(async {
        shutdown_notify().notified().await;
    });
    eprintln!("[sync-core-daemon] 收到 IPC 优雅停止 ⇒ 退出（endpoint/锁由 Drop 清理）");
    0
}

// ── ⭐ P3-1b IPC 骨架（task-63）：回环 endpoint ＋ Bearer 鉴权 ＋ 最小 HTTP/1.1 ──────────────
//
// 安全边界（本文件的承重）：
// * **只绑回环** `127.0.0.1:0`（⛔ 不绑 0.0.0.0/LAN）；
// * endpoint 文件 `<app data>/sync_core.endpoint.json`（`{port, token}`；unix 0600），
//   `Drop` 尽力删除；token 用 `crypto::random_32` **32 hex 字符**（16 字节）；
// * 所有请求：`Authorization: Bearer <token>`（常数时间比较）＋ `Host`/`Origin` **必须是回环**
//   （挡 DNS rebinding：`127.0.0.1.evil` 这类**不**算回环）；否则 401/403；
// * 只提供 `GET /status`、`POST /round`；其他路径 404、已知路径错方法 405、请求体 >1KiB 413；
// * ⛔ 不打印 token、错误信息不夹带 token；⛔ 本笔 App 只**只读**查询 `/status`，不触发 round。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// daemon 回环 endpoint 文件名（唯一出处）。
pub const ENDPOINT_FILE_NAME: &str = "sync_core.endpoint.json";
/// IPC 请求体上限（本笔 round 不需要请求体；只防滥用）。
pub const IPC_MAX_BODY_BYTES: usize = 1024;
/// IPC 单连接读请求头上限。
const IPC_MAX_HEADER_BYTES: usize = 8 * 1024;
/// App 只读查询 `/status` 的短超时（daemon 不在 ⇒ 快速降级，不卡 UI）。
pub const IPC_STATUS_TIMEOUT_MS: u64 = 400;
/// ⭐ task-64：**IPC 优雅停止**的等待窗口 —— 超过它还没退出才回退 TERM。
pub const IPC_SHUTDOWN_GRACE_MS: u64 = 2_000;

/// daemon 主循环等待的 shutdown 信号；`POST /shutdown` 先回 200 再 `notify_one()`。
static SHUTDOWN: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();

fn shutdown_notify() -> &'static tokio::sync::Notify {
    SHUTDOWN.get_or_init(tokio::sync::Notify::new)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncCoreEndpoint {
    pub port: u16,
    pub token: String,
}

/// endpoint 文件路径。
pub fn endpoint_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(ENDPOINT_FILE_NAME)
}

/// 写 endpoint（unix 权限 **0600**；含 token ⇒ ⛔ 不 world-readable）。
pub fn write_endpoint(path: &Path, ep: &SyncCoreEndpoint) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建 endpoint 目录失败：{e}"))?;
    }
    let text = serde_json::to_string(ep).map_err(|e| format!("endpoint 序列化失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("建 endpoint 文件失败：{e}"))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("写 endpoint 失败：{e}"))?;
        // 已存在文件可能旧权限更宽：显式再设一次。
        let _ = std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, text).map_err(|e| format!("写 endpoint 失败：{e}"))?;
    }
    Ok(())
}

/// 读 endpoint；文件不存在/坏 JSON/字段非法 ⇒ 可读 `Err`（调用方降级，不抛 UI）。
pub fn read_endpoint(path: &Path) -> Result<SyncCoreEndpoint, String> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "daemon 未运行（没有 endpoint 文件）".to_string()
        } else {
            format!("读 endpoint 失败：{e}")
        }
    })?;
    let ep: SyncCoreEndpoint = serde_json::from_str(&text)
        .map_err(|_| "endpoint 文件内容坏了（JSON 不合法）".to_string())?;
    if ep.port == 0 || ep.token.trim().is_empty() || ep.token.len() > 128 {
        return Err("endpoint 文件字段非法（port/token）".to_string());
    }
    Ok(ep)
}

/// endpoint 文件守门：`Drop` 尽力删除（daemon 退出后 App 查不到 ⇒ 降级）。
pub struct EndpointFileGuard {
    path: PathBuf,
}

impl EndpointFileGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for EndpointFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 解析后的最小 HTTP/1.1 请求（判据可直接喂）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body_len: usize,
}

/// 解析请求头（到 `\r\n\r\n`；方法/路径/头；⛔ 不解析 body 内容）。
pub fn parse_http_request(head: &[u8]) -> Result<ParsedRequest, String> {
    let text = std::str::from_utf8(head).map_err(|_| "请求头不是 UTF-8".to_string())?;
    let head_end = text.find("\r\n\r\n").ok_or("请求头不完整（没有空行）")?;
    let mut lines = text[..head_end].split("\r\n");
    let first = lines.next().ok_or("缺请求行")?;
    let mut parts = first.split_whitespace();
    let method = parts.next().ok_or("缺方法")?.to_ascii_uppercase();
    let target = parts.next().ok_or("缺路径")?;
    let path = target.split('?').next().unwrap_or(target).to_string();
    let mut headers = BTreeMap::new();
    let mut body_len = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or("请求头缺冒号")?;
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if name == "content-length" {
            body_len = value.parse::<usize>().map_err(|_| "Content-Length 非法")?;
        }
        headers.insert(name, value);
    }
    Ok(ParsedRequest {
        method,
        path,
        headers,
        body_len,
    })
}

/// 路由决策（鉴权通过后）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcRoute {
    Status,
    Round,
    /// ⭐ task-64：优雅停止（先回 200 再唤醒主循环）。
    Shutdown,
}

/// 鉴权/路由结果里的拒绝码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcReject {
    Unauthorized,
    Forbidden,
    MethodNotAllowed,
    NotFound,
    PayloadTooLarge,
    BadRequest,
}

impl IpcReject {
    pub fn status_code(self) -> u16 {
        match self {
            IpcReject::Unauthorized => 401,
            IpcReject::Forbidden => 403,
            IpcReject::MethodNotAllowed => 405,
            IpcReject::NotFound => 404,
            IpcReject::PayloadTooLarge => 413,
            IpcReject::BadRequest => 400,
        }
    }

    pub fn reason(self) -> &'static str {
        match self {
            IpcReject::Unauthorized => "unauthorized",
            IpcReject::Forbidden => "forbidden",
            IpcReject::MethodNotAllowed => "method_not_allowed",
            IpcReject::NotFound => "not_found",
            IpcReject::PayloadTooLarge => "payload_too_large",
            IpcReject::BadRequest => "bad_request",
        }
    }
}

/// 常数时间字符串比较（token 不许因为比较耗时泄露前缀）。
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Host 头必须是**回环**：`127.0.0.1` / `localhost` / `[::1]`（可带端口）；
/// ⛔ `127.0.0.1.evil`、`localhost.evil`、LAN IP、任意域名都不算。
pub fn is_loopback_host_header(value: &str) -> bool {
    let v = value.trim();
    if v.starts_with('[') {
        // [::1]:port（`]` 之后只允许空或 `:port`；⛔ `[::1].evil` 不算）。
        let Some(end) = v.find(']') else { return false };
        let host = &v[1..end];
        let rest = &v[end + 1..];
        return host == "::1" && (rest.is_empty() || rest.starts_with(':'));
    }
    let host = v.split(':').next().unwrap_or(v);
    host == "127.0.0.1" || host == "localhost"
}

/// Origin（若带）必须是回环：`http(s)://127.0.0.1[:port]` / `localhost` / `[::1]`。
pub fn is_loopback_origin(value: &str) -> bool {
    let v = value.trim();
    let rest = v
        .strip_prefix("http://")
        .or_else(|| v.strip_prefix("https://"))
        .unwrap_or("");
    if rest.is_empty() {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or(rest);
    is_loopback_host_header(authority)
}

/// 鉴权 ＋ 路由 ＋ 方法限制（纯函数；判据直接喂）。
pub fn authorize_request(req: &ParsedRequest, token: &str) -> Result<IpcRoute, IpcReject> {
    // ① token（Authorization: Bearer <token>；⛔ 不做大小写模糊匹配 token 本身）。
    let auth = req
        .headers
        .get("authorization")
        .map(String::as_str)
        .unwrap_or("");
    let Some(bearer) = auth.strip_prefix("Bearer ") else {
        return Err(IpcReject::Unauthorized);
    };
    if !ct_eq(bearer.trim(), token) {
        return Err(IpcReject::Unauthorized);
    }
    // ② 回环 Host（HTTP/1.1 必须带；缺 ⇒ 403）。
    let Some(host) = req.headers.get("host") else {
        return Err(IpcReject::Forbidden);
    };
    if !is_loopback_host_header(host) {
        return Err(IpcReject::Forbidden);
    }
    // ③ Origin 若带，也必须回环（挡浏览器跨站/DNS rebinding）。
    if let Some(origin) = req.headers.get("origin") {
        if !is_loopback_origin(origin) {
            return Err(IpcReject::Forbidden);
        }
    }
    // ④ 请求体上限（本笔不需要 body；只防滥用）。
    if req.body_len > IPC_MAX_BODY_BYTES {
        return Err(IpcReject::PayloadTooLarge);
    }
    // ⑤ 路由/方法。
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/status") => Ok(IpcRoute::Status),
        ("POST", "/round") => Ok(IpcRoute::Round),
        ("POST", "/shutdown") => Ok(IpcRoute::Shutdown),
        ("GET", "/round") | ("POST", "/status") | ("GET", "/shutdown") => {
            Err(IpcReject::MethodNotAllowed)
        }
        _ => Err(IpcReject::NotFound),
    }
}

/// 最小 JSON 响应（`Connection: close`）。
fn ipc_http_response(code: u16, reason: &str, body: &[u8]) -> Vec<u8> {
    let mut head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    out
}

/// 启动回环 IPC（只为 daemon 用；失败由调用方**只记日志**、不影响 daemon 主循环）。
///
/// 返回 `(port, guard)`：guard Drop 时删 endpoint 文件。token **不打印**。
pub async fn start_ipc(app: tauri::AppHandle) -> Result<(u16, EndpointFileGuard), String> {
    use tauri::Manager as _;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("绑回环失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读 IPC 端口失败：{e}"))?
        .port();
    let app_data_dir = crate::db::resolve_app_data_dir(app.path().app_data_dir().ok())
        .ok_or("拿不到应用数据目录")?;
    let token = hex::encode(&crate::crypto::random_32()[..16]); // 32 hex
    let path = endpoint_path(&app_data_dir);
    write_endpoint(
        &path,
        &SyncCoreEndpoint {
            port,
            token: token.clone(),
        },
    )?;
    let guard = EndpointFileGuard::new(path);
    tauri::async_runtime::spawn(async move {
        loop {
            let (sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[sync-core-ipc] accept 失败（继续监听）：{e}");
                    continue;
                }
            };
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_ipc_conn(sock, app, token).await;
            });
        }
    });
    Ok((port, guard))
}

/// 单连接：读头（上限/超时）→ 鉴权 → 路由 → 响应（⛔ 错误不夹带 token）。
async fn handle_ipc_conn(
    mut sock: tokio::net::TcpStream,
    app: tauri::AppHandle,
    token: String,
) -> Result<(), String> {
    use tauri::Manager as _;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    let read_head = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return Ok(());
            }
            if buf.len() > IPC_MAX_HEADER_BYTES {
                return Err("请求头过大".to_string());
            }
            let n = sock.read(&mut tmp).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("连接提前关闭".to_string());
            }
            buf.extend_from_slice(&tmp[..n]);
        }
    })
    .await;
    let req = match read_head {
        Ok(Ok(())) => match parse_http_request(&buf) {
            Ok(r) => r,
            Err(_) => {
                let _ = sock
                    .write_all(&ipc_http_response(
                        400,
                        "Bad Request",
                        b"{\"error\":\"bad_request\"}",
                    ))
                    .await;
                return Ok(());
            }
        },
        _ => {
            let _ = sock
                .write_all(&ipc_http_response(
                    400,
                    "Bad Request",
                    b"{\"error\":\"bad_request\"}",
                ))
                .await;
            return Ok(());
        }
    };
    let route = match authorize_request(&req, &token) {
        Ok(r) => r,
        Err(rej) => {
            let body = serde_json::json!({ "error": rej.reason() }).to_string();
            let _ = sock
                .write_all(&ipc_http_response(
                    rej.status_code(),
                    rej.reason(),
                    body.as_bytes(),
                ))
                .await;
            return Ok(());
        }
    };
    // ⭐ task-64：**先回 200，再 Notify**（响应先落到 socket，App 侧能立刻看到"优雅停止已受理"；
    //   若先 Notify，主循环可能在我们写响应前就退出 ⇒ App 看到的是连接被关）。
    if route == IpcRoute::Shutdown {
        let _ = sock
            .write_all(&ipc_http_response(200, "OK", b"{\"ok\":true}"))
            .await;
        let _ = sock.flush().await;
        shutdown_notify().notify_one();
        return Ok(());
    }
    let body = match route {
        IpcRoute::Shutdown => unreachable!("shutdown 已在上面的分支提前返回"),
        IpcRoute::Status => serde_json::to_vec(&crate::sync_core::snapshot())
            .map_err(|e| format!("status 序列化失败：{e}"))?,
        IpcRoute::Round => {
            let db = app.state::<crate::db::Db>();
            match crate::sync::sync_core_round_inner(&app, &db).await {
                Ok(report) => {
                    serde_json::to_vec(&report).map_err(|e| format!("round 序列化失败：{e}"))?
                }
                Err(e) => {
                    // ⚠️ 错误只回可读原因（不含 token/路径）。
                    let body = serde_json::json!({ "error": e }).to_string();
                    let _ = sock
                        .write_all(&ipc_http_response(
                            500,
                            "Internal Server Error",
                            body.as_bytes(),
                        ))
                        .await;
                    return Ok(());
                }
            }
        }
    };
    let _ = sock.write_all(&ipc_http_response(200, "OK", &body)).await;
    Ok(())
}

/// ⭐ **App 只读查询**（task-63）：`{reachable, reason?, status?}` —— daemon 不在/文件坏/超时
/// **一律降级**（⛔ 不抛 UI、⛔ 不触发 round、⛔ 不带 token 到错误里）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCoreIpcStatus {
    pub reachable: bool,
    pub reason: Option<String>,
    pub status: Option<crate::sync_core::SyncCoreStatus>,
}

/// ⭐ App 侧只读命令：读 endpoint → 短超时 GET `/status`；失败只回 reason。
#[tauri::command]
pub async fn sync_core_ipc_status(app: tauri::AppHandle) -> SyncCoreIpcStatus {
    use tauri::Manager as _;
    let Some(app_data_dir) = crate::db::resolve_app_data_dir(app.path().app_data_dir().ok()) else {
        return SyncCoreIpcStatus {
            reachable: false,
            reason: Some("拿不到应用数据目录".to_string()),
            status: None,
        };
    };
    let ep = match read_endpoint(&endpoint_path(&app_data_dir)) {
        Ok(ep) => ep,
        Err(reason) => {
            return SyncCoreIpcStatus {
                reachable: false,
                reason: Some(reason),
                status: None,
            };
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(IPC_STATUS_TIMEOUT_MS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return SyncCoreIpcStatus {
                reachable: false,
                reason: Some(format!("建 HTTP 客户端失败：{e}")),
                status: None,
            };
        }
    };
    let url = format!("http://127.0.0.1:{}/status", ep.port);
    match client
        .get(&url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", ep.token),
        )
        .send()
        .await
    {
        Ok(resp) => {
            let code = resp.status();
            if !code.is_success() {
                return SyncCoreIpcStatus {
                    reachable: false,
                    reason: Some(format!("daemon 回 HTTP {}", code.as_u16())),
                    status: None,
                };
            }
            match resp.json::<crate::sync_core::SyncCoreStatus>().await {
                Ok(status) => SyncCoreIpcStatus {
                    reachable: true,
                    reason: None,
                    status: Some(status),
                },
                Err(_) => SyncCoreIpcStatus {
                    reachable: false,
                    reason: Some("daemon 回的 status 不是合法 JSON".to_string()),
                    status: None,
                },
            }
        }
        Err(e) if e.is_timeout() => SyncCoreIpcStatus {
            reachable: false,
            reason: Some("daemon 响应超时".to_string()),
            status: None,
        },
        Err(e) => SyncCoreIpcStatus {
            reachable: false,
            reason: Some(if e.is_connect() {
                "daemon 不在（连不上回环端口）".to_string()
            } else {
                format!("查 daemon 状态失败：{e}")
            }),
            status: None,
        },
    }
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

    // ⭐ 2026-11-09（真机现场：强杀后 `sync_core.lock` 留着死 pid ⇒ 应用打不开）：
    //   **PID 存活判定必须真的去问操作系统**。Windows 以前一律返回 `true`（"保守"），
    //   于是这条断言在 Windows 上从来没人跑到过 —— 它今天就是那次"打不开"的机器判据。
    #[test]
    fn pid_alive_asks_the_os_and_reports_dead_for_a_missing_pid() {
        assert!(pid_alive(std::process::id()), "自己必须算活着");
        assert!(
            !pid_alive(999_999_999),
            "一个不存在的 pid 必须算死（否则残留锁永远不回收 ⇒ 应用再也打不开）"
        );
    }

    #[test]
    fn lock_pid_parsing_is_lenient_but_bounded() {        assert_eq!(parse_lock_pid("1234\njunk"), Some(1234));
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

    // ── ⭐ task-63：IPC endpoint / 鉴权 / 回环 / 降级 ─────────────────────────────

    fn hdr(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
            .collect()
    }

    fn req(
        method: &str,
        path: &str,
        headers: BTreeMap<String, String>,
        body_len: usize,
    ) -> ParsedRequest {
        ParsedRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body_len,
        }
    }

    fn valid_headers(token: &str) -> BTreeMap<String, String> {
        hdr(&[
            ("Authorization", &format!("Bearer {token}")),
            ("Host", "127.0.0.1:49152"),
        ])
    }

    #[test]
    fn endpoint_file_round_trips_with_0600_and_is_removed_on_drop() {
        let dir = temp_dir("endpoint");
        let path = endpoint_path(&dir);
        let ep = SyncCoreEndpoint {
            port: 49152,
            token: "a".repeat(32),
        };
        write_endpoint(&path, &ep).expect("写 endpoint");
        assert_eq!(read_endpoint(&path).unwrap(), ep);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "endpoint 含 token ⇒ 必须 0600（实际 {mode:o}）"
            );
        }
        let guard = EndpointFileGuard::new(path.clone());
        drop(guard);
        assert!(!path.exists(), "Drop 必须尽力删除 endpoint 文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_and_corrupt_endpoint_files_degrade_readably() {
        let dir = temp_dir("endpoint-bad");
        let path = endpoint_path(&dir);
        assert!(read_endpoint(&path).unwrap_err().contains("daemon 未运行"));
        std::fs::write(&path, "not json").unwrap();
        assert!(read_endpoint(&path).unwrap_err().contains("坏了"));
        std::fs::write(&path, r#"{"port":0,"token":"x"}"#).unwrap();
        assert!(read_endpoint(&path).unwrap_err().contains("非法"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ipc_requires_bearer_token_and_loopback_host_origin() {
        let token = "0123456789abcdef0123456789abcdef";
        // 无/错 token ⇒ 401（不论路径，先鉴权）。
        assert_eq!(
            authorize_request(
                &req("GET", "/status", hdr(&[("Host", "127.0.0.1:1")]), 0),
                token
            ),
            Err(IpcReject::Unauthorized)
        );
        assert_eq!(
            authorize_request(
                &req(
                    "GET",
                    "/status",
                    hdr(&[("Authorization", "Bearer wrong"), ("Host", "127.0.0.1:1")]),
                    0
                ),
                token
            ),
            Err(IpcReject::Unauthorized)
        );
        // 正确 token ＋ Host 回环 ⇒ 通过。
        assert_eq!(
            authorize_request(&req("GET", "/status", valid_headers(token), 0), token),
            Ok(IpcRoute::Status)
        );
        // Host 非回环 ⇒ 403（含前缀攻击形状）。
        for bad_host in [
            "127.0.0.1.evil",
            "localhost.evil",
            "192.168.1.5:8788",
            "",
            "evil.com",
        ] {
            let h = hdr(&[
                ("Authorization", &format!("Bearer {token}")),
                ("Host", bad_host),
            ]);
            assert_eq!(
                authorize_request(&req("GET", "/status", h, 0), token),
                Err(IpcReject::Forbidden),
                "⛔ 非回环 Host 必须 403：{bad_host:?}"
            );
        }
        // 缺 Host ⇒ 403。
        assert_eq!(
            authorize_request(
                &req(
                    "GET",
                    "/status",
                    hdr(&[("Authorization", &format!("Bearer {token}"))]),
                    0
                ),
                token
            ),
            Err(IpcReject::Forbidden)
        );
        // Origin 若带，非回环 ⇒ 403；回环 ⇒ 通过。
        for origin in [
            "http://evil.com",
            "http://127.0.0.1.evil",
            "https://192.168.1.5:8788",
        ] {
            let h = hdr(&[
                ("Authorization", &format!("Bearer {token}")),
                ("Host", "127.0.0.1:1"),
                ("Origin", origin),
            ]);
            assert_eq!(
                authorize_request(&req("GET", "/status", h, 0), token),
                Err(IpcReject::Forbidden),
                "⛔ 非回环 Origin 必须 403：{origin}"
            );
        }
        for origin in [
            "http://127.0.0.1:3000",
            "http://localhost:1420",
            "https://[::1]:1",
        ] {
            let h = hdr(&[
                ("Authorization", &format!("Bearer {token}")),
                ("Host", "127.0.0.1:1"),
                ("Origin", origin),
            ]);
            assert_eq!(
                authorize_request(&req("GET", "/status", h, 0), token),
                Ok(IpcRoute::Status),
                "回环 Origin 应通过：{origin}"
            );
        }
        // 回环判定本身（Host 可带端口；IPv6 方括号）。
        assert!(is_loopback_host_header("127.0.0.1"));
        assert!(is_loopback_host_header("127.0.0.1:8788"));
        assert!(is_loopback_host_header("localhost:1420"));
        assert!(is_loopback_host_header("[::1]:49152"));
        assert!(!is_loopback_host_header("[::1].evil"));
        assert!(!is_loopback_host_header("0.0.0.0:8788"));
    }

    #[test]
    fn ipc_routes_methods_404_and_body_cap() {
        let token = "0123456789abcdef0123456789abcdef";
        let ok = |m: &str, p: &str| authorize_request(&req(m, p, valid_headers(token), 0), token);
        assert_eq!(ok("GET", "/status"), Ok(IpcRoute::Status));
        assert_eq!(ok("POST", "/round"), Ok(IpcRoute::Round));
        assert_eq!(ok("POST", "/shutdown"), Ok(IpcRoute::Shutdown));
        assert_eq!(ok("POST", "/status"), Err(IpcReject::MethodNotAllowed));
        assert_eq!(ok("GET", "/round"), Err(IpcReject::MethodNotAllowed));
        assert_eq!(ok("GET", "/shutdown"), Err(IpcReject::MethodNotAllowed));
        assert_eq!(ok("PUT", "/status"), Err(IpcReject::NotFound));
        assert_eq!(ok("GET", "/../status"), Err(IpcReject::NotFound));
        assert_eq!(ok("GET", "/status/extra"), Err(IpcReject::NotFound));
        // 请求体上限。
        assert_eq!(
            authorize_request(
                &req(
                    "POST",
                    "/round",
                    valid_headers(token),
                    IPC_MAX_BODY_BYTES + 1
                ),
                token
            ),
            Err(IpcReject::PayloadTooLarge)
        );
        // 解析：缺空行/坏头 ⇒ Err。
        assert!(parse_http_request(b"GET /status HTTP/1.1\r\nHost: x\r\n").is_err());
        assert!(parse_http_request(b"GET /status HTTP/1.1\r\nHost 127.0.0.1\r\n\r\n").is_err());
        let parsed = parse_http_request(
            b"POST /round?x=1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/round");
        assert_eq!(parsed.body_len, 0);
    }

    /// 源码级安全边界：只绑回环、endpoint 0600、token 不打印、路由只有两个、App 命令只读。
    #[test]
    fn the_ipc_skeleton_is_loopback_only_and_the_app_command_is_read_only() {
        let me = include_str!("sync_core_daemon.rs");
        let prod = me.split("#[cfg(test)]").next().unwrap_or(me);
        assert!(
            prod.contains(r#"TcpListener::bind(("127.0.0.1", 0))"#),
            "⛔ 必须绑 127.0.0.1:0"
        );
        assert!(!prod.contains(r#"bind(("0.0.0.0""#), "⛔ 不许绑 0.0.0.0");
        assert!(me.contains(".mode(0o600)"), "endpoint 必须 0600");
        assert!(me.contains("token 不打印"), "token 不许打印");
        // 路由只有 /status 与 /round（⛔ 不加别的）。
        assert!(me.contains(r#"("GET", "/status") => Ok(IpcRoute::Status)"#));
        assert!(me.contains(r#"("POST", "/round") => Ok(IpcRoute::Round)"#));
        // App 命令只 GET /status，不触发 round；失败一律 reachable=false。
        let cmd = me
            .split("pub async fn sync_core_ipc_status(")
            .nth(1)
            .expect("App 只读命令必须在");
        let cmd = cmd.split("#[cfg(test)]").next().unwrap_or(cmd);
        assert!(cmd.contains("/status"));
        assert!(!cmd.contains("/round"), "⛔ 本笔 App 命令不许触发 round");
        assert!(!cmd.contains("post("), "⛔ 只读：不许 POST");
        assert!(cmd.contains("IPC_STATUS_TIMEOUT_MS"));
        assert!(cmd.contains("reachable: false"));
        // daemon 启动顺序：锁 → DB → IPC → 调度器。
        let run = me.split("pub fn run_daemon()").nth(1).expect("run_daemon");
        let lock_at = run.find("acquire_in(&app_data_dir").expect("锁");
        let init_at = run.find("crate::db::init(").expect("DB");
        let ipc_at = run.find("start_ipc(app.handle().clone())").expect("IPC");
        let sched_at = run
            .find("set_runtime_enabled(app.handle(), true)")
            .expect("调度器");
        assert!(lock_at < init_at && init_at < ipc_at && ipc_at < sched_at);
        // 命令已注册。
        assert!(include_str!("lib.rs").contains("sync_core_daemon::sync_core_ipc_status,"));
    }

    // ── ⭐ task-64：/shutdown 优雅停止 + App IPC 优先 ───────────────────────────

    #[test]
    fn shutdown_notify_wakes_the_daemon_waiter() {
        // Notify 有 permit 语义：先 notify 再 await 也不会丢。
        let woke = tauri::async_runtime::block_on(async {
            shutdown_notify().notify_one();
            tokio::time::timeout(
                std::time::Duration::from_millis(200),
                shutdown_notify().notified(),
            )
            .await
            .is_ok()
        });
        assert!(woke, "notify_one 之后阻塞等待必须被唤醒");
    }

    #[test]
    fn ipc_shutdown_uses_the_same_auth_and_is_post_only() {
        let token = "0123456789abcdef0123456789abcdef";
        let headers = valid_headers(token);
        assert_eq!(
            authorize_request(&req("POST", "/shutdown", headers.clone(), 0), token),
            Ok(IpcRoute::Shutdown)
        );
        // GET ⇒ 405（同其他已知路径）。
        assert_eq!(
            authorize_request(&req("GET", "/shutdown", headers.clone(), 0), token),
            Err(IpcReject::MethodNotAllowed)
        );
        // 无/错 token ⇒ 401；非回环 Host/Origin ⇒ 403（与 /status 完全同一把尺）。
        assert_eq!(
            authorize_request(
                &req("POST", "/shutdown", hdr(&[("Host", "127.0.0.1:1")]), 0),
                token
            ),
            Err(IpcReject::Unauthorized)
        );
        for bad_host in ["127.0.0.1.evil", "192.168.1.5:8788", "evil.com"] {
            let h = hdr(&[
                ("Authorization", &format!("Bearer {token}")),
                ("Host", bad_host),
            ]);
            assert_eq!(
                authorize_request(&req("POST", "/shutdown", h, 0), token),
                Err(IpcReject::Forbidden)
            );
        }
        let h = hdr(&[
            ("Authorization", &format!("Bearer {token}")),
            ("Host", "127.0.0.1:1"),
            ("Origin", "http://evil.com"),
        ]);
        assert_eq!(
            authorize_request(&req("POST", "/shutdown", h, 0), token),
            Err(IpcReject::Forbidden)
        );
    }

    /// 源码级：先回 200 再 Notify；daemon 主循环等 Notify；App 停止路径 IPC 优先、TERM 兜底、
    /// 且仍先校验 role/pid（确认门在 acquire_for_app_or_exit，已有判据）。
    #[test]
    fn shutdown_responds_before_notify_and_stop_prefers_ipc() {
        let me = include_str!("sync_core_daemon.rs");
        let prod = me.split("#[cfg(test)]").next().unwrap_or(me);
        // ① handler：200 响应写入/flush 都在 notify 之前。
        let shutdown_branch = prod
            .split("if route == IpcRoute::Shutdown {")
            .nth(1)
            .expect("shutdown 分支必须在");
        let branch = &shutdown_branch[..shutdown_branch
            .find("return Ok(())")
            .unwrap_or(shutdown_branch.len())];
        let write_at = branch.find("ipc_http_response(200").expect("先回 200");
        let flush_at = branch.find(".flush()").expect("flush");
        let notify_at = branch
            .find("shutdown_notify().notify_one()")
            .expect("再 Notify");
        assert!(
            write_at < flush_at && flush_at < notify_at,
            "⛔ 必须先回 200 再 Notify"
        );
        // ② 主循环等 Notify（不再 pending），正常退出 0。
        assert!(prod.contains("shutdown_notify().notified().await"));
        assert!(!prod.contains("std::future::pending::<()>()"));
        assert!(prod.contains("收到 IPC 优雅停止"));
        // ③ App 停止路径：先 role/pid 校验 → IPC → 宽限 → TERM；顺序钉死。
        let stop = prod
            .split("pub fn stop_daemon_and_retry(")
            .nth(1)
            .expect("stop 必须在");
        let role_at = stop
            .find("if !terminate_allowed(&info, true)")
            .expect("role 校验");
        let pid_at = stop.find("if info.pid != Some(pid)").expect("pid 校验");
        let ipc_at = stop.find("shutdown_via_ipc(&ep)").expect("IPC 优先");
        let term_at = stop.find("send_term(pid)?").expect("TERM 兜底");
        assert!(role_at < pid_at && pid_at < ipc_at && ipc_at < term_at);
        assert!(stop.contains("IPC_SHUTDOWN_GRACE_MS"));
        assert!(stop.contains("回退 TERM"));
        // ④ IPC 停止本身也走 Bearer POST /shutdown（短超时、不打印 token）。
        let helper = prod
            .split("fn shutdown_via_ipc(")
            .nth(1)
            .expect("shutdown_via_ipc 必须在");
        let helper = match helper.find("/// ⭐ App 启动抢锁") {
            Some(end) => &helper[..end],
            None => helper,
        };
        assert!(helper.contains("/shutdown"));
        assert!(helper.contains("AUTHORIZATION"));
        assert!(helper.contains("IPC_STATUS_TIMEOUT_MS"));
        assert!(!helper.contains("eprintln!"));
    }
}
