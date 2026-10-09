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
    shuyonote_lib::run()
}
