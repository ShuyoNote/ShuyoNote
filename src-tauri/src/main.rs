// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ⭐ P3：无头 `--backup-once` ⇒ 跑一次备份就退出（⛔ 不建窗口 ✓）
    // 与 `lib.rs` 的 `run()` 里那条子进程分流**同形** ✓（那里是 plugin_host 的 HOST_FLAG ✓）
    if shuyonote_lib::auto_backup::cli_mode(std::env::args().skip(1))
        == shuyonote_lib::auto_backup::CliMode::BackupOnce
    {
        std::process::exit(shuyonote_lib::run_backup_once());
    }
    // ⭐ task-10 ③：`--import <文件>`（Office 导入第一期）—— **冷启动**这一半：
    //    把待导入路径记进本进程（真正交付给前端的那一行在 `lib.rs` 的 `.setup()` 里 ✓）。
    //    ⛔ 单实例守卫**不在这里**：它由 `lib.rs` 注册的 `tauri_plugin_single_instance` 负责 ✓
    //      （那个插件同样**不是**在本句之上起第二个 guard —— 那会变成两份真相源 ✗）。
    //    `--backup-once` 优先级更高（上面那条已先返回 ⇒ 无头备份不建窗口 ✓）。
    if let shuyonote_lib::office_import::Startup::Import { path } =
        shuyonote_lib::office_import::startup_from_args(std::env::args().skip(1))
    {
        shuyonote_lib::office_import::set_pending_import(&path);
    }
    shuyonote_lib::run()
}
