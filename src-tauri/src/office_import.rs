//! **`--import <文件>` 的参数解析 ＋ 待导入路径的交班**（Office 导入第一期 · task-10 ③）。
//!
//! ## 一、为什么是纯 `std`（⭐ 这是刻意的，别改成引 tauri）
//! 纯 std ⇒ ⭐ **不用 cargo 也能把单测跑起来**：
//! `rustc --test src-tauri/src/office_import.rs` ✓ —— 本机 `cargo` 那条链要编整棵树，
//! 而 `win-cargo-test.ps1` 又会先 `cargo build --bin shuyonote` ⇒ **替换正在运行的 app exe ⇒ 白屏** ✗
//! （见 `AGENTS.md` §7 与 `docs/TESTING.md`）。窄口径的判据能当场跑，比等冷编译值钱 ✓。
//! ⇒ 因此本文件**不许** `use tauri::…` ✗、不许碰数据库 ✗。需要 tauri 的那一丁点接线留在 `lib.rs`
//!   （**一行闭包** ✓，形状见 `forward_import_args` / `deliver_pending` 的注释 ✓）。
//!
//! ## 二、单实例守卫在哪（⛔ 不在这里重造第二份）
//! 守卫**已经有了**：`lib.rs` 注册的 `tauri_plugin_single_instance`（`lib.rs:346` 那一段），
//! 其上方注释逐字写着「单实例：禁止多开。ShuyoNote 是本地优先单库…多实例会互相覆盖 token、
//! device 绑定冲突」✓ ⇒ 本模块**只做两件事**：① argv ⇒ `Startup`；② 把路径**交班**给"最终要导入它的那个进程" ✓
//!   ⛔ 绝不自己起第二个 guard（那会变成两份真相源 ✗）。
//!
//! ## 三、口径（照实，与 `auto_backup::cli_mode` 同族）
//! - `--import <路径>` 与 `--import=<路径>` 都认 ✓；路径两侧的引号会剥掉 ✓（Windows 关联带引号 ✓）
//! - 多个 `--import` ⇒ 取**第一个** ✓（系统关联只会给一个；多给不报错、也不覆盖 ✓）
//! - `--import` 后面**没有值** ⇒ **照旧正常启动** ✓（⛔ 不因为参数写错就不建窗口 ✗
//!   —— 那会让用户以为应用坏了，理由与 `auto_backup::cli_mode` 里那段逐字一致 ✓）
//! - 其余参数一概**不认也不吞** ✓（照旧正常启动 ✓）
//! - `--backup-once` **优先**（无头备份不建窗口 ✓）：两者不叠加，`main.rs` 里先判备份 ✓
//!
//! ## 四、边界（照实）
//! - ⛔ 不在这里判扩展名／不校验文件存在性 —— 那是导入层的活，而且**要求它可读失败** ✓
//!   （本模块只负责"把用户给的那条路径原样带到该到的地方" ✓）。
//! - ⛔ 不做 `tauri.conf.json` 的文件关联登记（**第二期** ✗）；这里只认命令行那一条 ✓。

use std::sync::Mutex;

/// 那条命令行开关（与方案 §5.1 的 `--import "%1"` 同名 ✓）。
pub const IMPORT_FLAG: &str = "--import";

/// 交班事件名：`lib.rs` 把待导入路径 emit 给前端时用它 ✓
/// （⚠️ 前端「收到事件后调导入管线」那一半是**接线**的事，见报告里的"未接线"清单 ✓）。
pub const IMPORT_EVENT: &str = "office-import://request";

/// 启动模式（⭐ 纯数据 ⇒ 可断言 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Startup {
    /// 正常启动（建窗口 ✓）
    Normal,
    /// `--import <路径>` ⇒ 启动后要把这个文件导成笔记
    Import { path: String },
}

/// 剥掉两侧成对的引号（Windows 的文件关联把 `%1` 传进来时常带引号 ✓）。
fn unquote(raw: &str) -> String {
    let t = raw.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return t[1..t.len() - 1].to_string();
        }
    }
    t.to_string()
}

/// 从 argv（**不含程序名自身**）判启动模式（⭐ **纯函数** ⇒ 可单测 ✓）。
pub fn startup_from_args<I: IntoIterator<Item = String>>(args: I) -> Startup {
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == IMPORT_FLAG {
            // `--import <路径>`：下一个参数才是值
            return match it.next() {
                Some(value) => {
                    let path = unquote(&value);
                    if path.is_empty() {
                        Startup::Normal // ⛔ 空值不算"要导入"——照旧正常启动 ✓
                    } else {
                        Startup::Import { path }
                    }
                }
                // ⛔ 没有值 ⇒ 照旧正常启动（不因为参数写错就不建窗口 ✓）
                None => Startup::Normal,
            };
        }
        // `--import=<路径>` 形态（同一个开关，别漏 ✓）
        if let Some(rest) = arg.strip_prefix(IMPORT_FLAG) {
            if let Some(value) = rest.strip_prefix('=') {
                let path = unquote(value);
                if !path.is_empty() {
                    return Startup::Import { path };
                }
                return Startup::Normal;
            }
        }
    }
    Startup::Normal
}

/// 待导入路径（**进程内**一次性交班）。
///
/// ⚠️ 为什么用进程内的 `static` 而不是环境变量：`std::env::set_var` 在多线程下**不是**安全的
/// （且新版 edition 里已经是 `unsafe`）✗；而这条交班**只在同一个进程内**（`main` → `run` → 前端）
/// 发生 ✓ ⇒ 一把 `Mutex` 就够，且**不需要**碰环境 ✓。
static PENDING: Mutex<Option<String>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<String>> {
    // ⚠️ 中毒（poison）不该让"导入"这件事整个失效 ⇒ 取回内层值继续 ✓（本模块没有会 panic 的临界区 ✓）
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

/// 冷启动：`main.rs` 在 `run()` **之前**把 `--import` 给的路径记下 ✓
/// （真正交付由 `lib.rs` 的 setup 调 `deliver_pending` ✓）。
pub fn set_pending_import(path: &str) {
    *lock() = Some(path.to_string());
}

/// 交付待导入路径：有就交给 `emit`，并且**取走**（⇒ 只交付一次 ✓）。
/// ⭐ 接线那一行长这样（`lib.rs` 的 `.setup(...)` 里 ✓）：
/// ```ignore
/// office_import::deliver_pending(|p| { let _ = app.emit(office_import::IMPORT_EVENT, p.to_string()); });
/// ```
pub fn deliver_pending<F: FnOnce(&str)>(emit: F) -> Option<String> {
    let taken = lock().take();
    if let Some(path) = &taken {
        emit(path);
    }
    taken
}

/// **第二个实例**带来的 argv ⇒ 取出待导入路径 ⇒ 记下 ＋ 交给 `emit` ✓。
/// ⭐ 接线那一行在 `lib.rs:346` 的单实例回调里（`_args` 要改成 `args` ✓）：
/// ```ignore
/// office_import::forward_import_args(&args, |p| { let _ = app.emit(office_import::IMPORT_EVENT, p.to_string()); });
/// ```
/// ⚠️ 返回 `Some(path)` ⇒ 真的转发了；`None` ⇒ 这次唤起与导入无关（照旧只还原窗口 ✓）。
pub fn forward_import_args<F: FnOnce(&str)>(args: &[String], emit: F) -> Option<String> {
    match startup_from_args(args.iter().cloned()) {
        Startup::Import { path } => {
            set_pending_import(&path);
            emit(&path);
            Some(path)
        }
        Startup::Normal => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_flag_is_normal() {
        assert_eq!(startup_from_args(args(&[])), Startup::Normal);
        assert_eq!(startup_from_args(args(&["--other", "x"])), Startup::Normal);
    }

    #[test]
    fn import_with_space_separated_value() {
        assert_eq!(
            startup_from_args(args(&["--import", "C:\\tmp\\季度报告.docx"])),
            Startup::Import {
                path: "C:\\tmp\\季度报告.docx".to_string()
            }
        );
    }

    #[test]
    fn import_with_equals_value() {
        assert_eq!(
            startup_from_args(args(&["--import=C:\\tmp\\a.docx"])),
            Startup::Import {
                path: "C:\\tmp\\a.docx".to_string()
            }
        );
    }

    #[test]
    fn quoted_path_is_unquoted() {
        // Windows 的文件关联会把 `%1` 带引号地传进来 ✓（两种引号都认 ✓）
        assert_eq!(
            startup_from_args(args(&["--import", "\"C:\\Program Files\\a b.docx\""])),
            Startup::Import {
                path: "C:\\Program Files\\a b.docx".to_string()
            }
        );
        assert_eq!(
            startup_from_args(args(&["--import='C:\\带 空格.docx'"])),
            Startup::Import {
                path: "C:\\带 空格.docx".to_string()
            }
        );
    }

    #[test]
    fn missing_or_empty_value_starts_normally() {
        // ⛔ 参数写错**不许**让应用不建窗口 ✓（与 `auto_backup::cli_mode` 同一口径 ✓）
        assert_eq!(startup_from_args(args(&["--import"])), Startup::Normal);
        assert_eq!(startup_from_args(args(&["--import", ""])), Startup::Normal);
        assert_eq!(startup_from_args(args(&["--import="])), Startup::Normal);
        assert_eq!(startup_from_args(args(&["--import", "\"\""])), Startup::Normal);
    }

    #[test]
    fn first_import_wins_and_backup_flag_is_not_import() {
        assert_eq!(
            startup_from_args(args(&["--import", "a.docx", "--import", "b.docx"])),
            Startup::Import {
                path: "a.docx".to_string()
            }
        );
        // `--backup-once` 不是导入（它由 `main.rs` 更早那条分支处理 ✓）
        assert_eq!(startup_from_args(args(&["--backup-once"])), Startup::Normal);
    }

    /// ⚠️ 只写**一个**碰全局交班的用例：`PENDING` 是进程级的，多个用例并行会互相偷值 ✗
    /// （这一条刻意把"转发 ⇒ 交付"的整条序列放在同一个用例里 ✓）。
    #[test]
    fn forward_then_deliver_is_one_shot() {
        // 先清干净（同一进程里别的用例不碰它 ✓）
        let _ = deliver_pending(|_| {});

        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let forwarded = forward_import_args(&args(&["--import", "C:\\tmp\\x.docx"]), |p| {
            seen.borrow_mut().push(p.to_string());
        });
        assert_eq!(forwarded.as_deref(), Some("C:\\tmp\\x.docx"));
        assert_eq!(seen.borrow().as_slice(), ["C:\\tmp\\x.docx"]);

        // ⭐ 交付**只发一次**（第二次调 deliver_pending 什么也不发 ✓）
        let first = deliver_pending(|_| {});
        assert_eq!(first.as_deref(), Some("C:\\tmp\\x.docx"));
        assert_eq!(deliver_pending(|_| {}), None);

        // 与导入无关的唤起 ⇒ 不记录、不交付 ✓
        assert_eq!(forward_import_args(&args(&["--other"]), |_| {}), None);
        assert_eq!(deliver_pending(|_| {}), None);
    }
}
