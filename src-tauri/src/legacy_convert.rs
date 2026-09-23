//! 旧二进制 Office（`.doc` / `.xls` / `.ppt`）→ OOXML 的**平台转换器**。
//!
//! 抽取层（`src/lib/extract/legacy.ts`）认得出这三种旧格式，但**解不了**它们（OLE 复合文档，不是 zip）
//! ⇒ 它把字节交给 `deps.convertLegacy`，由**平台侧**这台机器上的 LibreOffice 做格式转换，
//! 转换结果再交回 `ooxml.ts` 那一族解析（**绝不在这里写第二套 docx/xlsx/pptx 解析**）。
//!
//! ## 三条刻意口径（与方案 §15.8 第 7 项、`src/lib/extract/types.ts` 的契约逐条对齐）
//!  1. **`to` 是目标 MIME**，由抽取器决定；本命令只回字节、不回 mime。
//!  2. **失败一律 `Err`**（没装转换器 / 非零退出 / 超时 / 输出不是 OOXML）⇒ 抽取器映射成 `provider_error`。
//!  3. **临时目录一定清掉**（成功、失败、超时三条路都清）—— 否则一台机器跑久了会悄悄堆满临时件。
//!
//! ## 为什么用"轮询 `try_wait` + 截止时间"而不是等一个 `wait_timeout` 依赖
//! `std` 没有带超时的 `wait`，而为一个调用点引第三方 crate（`wait-timeout`）要动共享的 `Cargo.toml`。
//! LibreOffice 挂住是本条命令**已知会发生的**事（headless 卡死），所以超时必须真有，且超时那一刻要
//! **杀掉子进程**、不能留下孤儿。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 一条转换给多久。90 秒对"一份旧 Office 文档 → OOXML"是很宽的上限；
/// 到点就杀进程并如实报错（宁可让用户看到"转换超时"，也不要无限等）。
pub(crate) const CONVERT_TIMEOUT: Duration = Duration::from_secs(90);

/// 没装 LibreOffice 时的原话。**必须点名"装什么"**：这是用户唯一能自救的信息。
pub(crate) const SOFFICE_MISSING: &str =
    "这台机器上没找到 LibreOffice（soffice）—— 旧版 Office 文件（.doc/.xls/.ppt）要靠它转成 OOXML 才能抽取。\
     装好后重试即可（macOS: brew install --cask libreoffice / Windows: 官网安装包 / Linux: apt install libreoffice-core）。";

/// 目标 MIME → 转换目标扩展名。只认三种 OOXML 目标；其余返回 `None`（调用方 reject）。
pub(crate) fn target_ext_for(to: &str) -> Option<&'static str> {
    match to.trim() {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        _ => None,
    }
}

/// 目标扩展名 → **源**扩展名。
///
/// 为什么需要它：LibreOffice 靠**扩展名**挑输入过滤器（内容嗅探不可靠）。而本命令的签名只有 `(data, to)`，
/// 源那一侧的类型由"要转成什么"唯一决定：`.docx ← .doc`、`.xlsx ← .xls`、`.pptx ← .ppt`
/// （旧格式只有这三族会走到这里，抽取器的 mime 认领也是这三族）。
pub(crate) fn source_ext_for(target_ext: &str) -> &'static str {
    match target_ext {
        "docx" => "doc",
        "xlsx" => "xls",
        "pptx" => "ppt",
        _ => "bin",
    }
}

/// 输出是不是一个 OOXML 容器（zip）。只做**最便宜**的那一层：真正的解析交给 `ooxml.ts` 那一族。
pub(crate) fn is_zip_container(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes[0] == 0x50 && bytes[1] == 0x4b && (bytes[2] == 0x03 || bytes[2] == 0x05 || bytes[2] == 0x07)
}

/// soffice 的候选位置（PATH 之外的三平台常见安装点）。顺序＝优先顺序。
pub(crate) fn soffice_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"));
    }
    if cfg!(target_os = "windows") {
        for base in ["C:\\Program Files\\LibreOffice", "C:\\Program Files (x86)\\LibreOffice"] {
            out.push(PathBuf::from(base).join("program").join("soffice.exe"));
        }
    }
    for p in ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"] {
        out.push(PathBuf::from(p));
    }
    out
}

/// 从候选里挑第一个**确实存在**的（`exists` 可注入 ⇒ 判据不必造真的 LibreOffice）。
pub(crate) fn pick_first_existing(
    paths: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    paths.iter().find(|p| exists(p)).cloned()
}

/// 找 `soffice`：先看 PATH（用户自己装的、或包管理器放进 PATH 的），再看三平台常见位置。
pub(crate) fn find_soffice() -> Option<PathBuf> {
    // PATH：交给 shell 解析会引入引号/扩展名问题，这里按 PATH 逐目录找可执行名。
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["soffice.exe", "soffice"]
    } else {
        &["soffice", "libreoffice"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        for dir in dirs {
            for n in names {
                let cand = dir.join(n);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    pick_first_existing(&soffice_candidates(), |p| p.is_file())
}

/// 临时目录的清理守卫：**任何**返回路径（成功 / Err / 提前 return）都会删掉它。
struct TempDirGuard(PathBuf);
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 真转换。`bin` / `timeout` / `tmp_root` 都可注入 ⇒ 判据用假脚本就能覆盖成功、非零退出、超时、
/// "输出不是 OOXML"四条路（**不必在这台机器上装 LibreOffice**）。
pub(crate) fn convert_with(
    bin: &Path,
    data: &[u8],
    target_ext: &str,
    timeout: Duration,
    tmp_root: &Path,
) -> Result<Vec<u8>, String> {
    let src_ext = source_ext_for(target_ext);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = tmp_root.join(format!("shuyonote-legacy-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败（{}）：{e}", dir.display()))?;
    let _guard = TempDirGuard(dir.clone());

    let input = dir.join(format!("input.{src_ext}"));
    std::fs::write(&input, data).map_err(|e| format!("写临时输入失败（{}）：{e}", input.display()))?;

    let mut child = Command::new(bin)
        .arg("--headless")
        .arg("--norestore")
        .arg("--convert-to")
        .arg(target_ext)
        .arg("--outdir")
        .arg(&dir)
        .arg(&input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("起转换器失败（{}）：{e}", bin.display()))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    // 把子进程的原话带出来（`--headless` 的报错常常只在 stderr）
                    let out = child.wait_with_output().map(|o| {
                        let mut s = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        if s.is_empty() {
                            s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        }
                        s
                    });
                    let detail = out.ok().filter(|s| !s.is_empty()).unwrap_or_default();
                    let tail: String = detail.chars().rev().take(300).collect::<String>().chars().rev().collect();
                    return Err(format!(
                        "转换器以非零状态退出（{}）：{tail}",
                        status.code().map(|c| c.to_string()).unwrap_or_else(|| "被信号结束".into())
                    ));
                }
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("转换超时（{}秒）—— 已杀掉转换器并清理临时目录", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待转换器失败：{e}")),
        }
    }

    let produced = dir.join(format!("input.{target_ext}"));
    let bytes = std::fs::read(&produced).map_err(|e| {
        format!(
            "转换器没有产出 {target_ext}（找 {} 失败：{e}）—— 源文件可能是别的格式或已损坏",
            produced.display()
        )
    })?;
    if !is_zip_container(&bytes) {
        return Err(format!(
            "转换产出的不是 OOXML 容器（{} 字节，前 4 字节不是 zip 魔数）—— 拒绝把不认识的东西当成转换成功",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// 命令面：`convert_legacy_office(data, to) -> bytes`。
///
/// 与 `docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md` §15.8 第 7 项同一条口径：
/// **`to` 由抽取器决定**、**失败一律 `Err`**、**临时件自清**。
#[tauri::command]
pub fn convert_legacy_office(data: Vec<u8>, to: String) -> Result<Vec<u8>, String> {
    let target_ext = target_ext_for(&to)
        .ok_or_else(|| format!("不支持的目标格式：{to}（本命令只把旧 Office 转成 docx/xlsx/pptx）"))?;
    let bin = find_soffice().ok_or_else(|| SOFFICE_MISSING.to_string())?;
    convert_with(&bin, &data, target_ext, CONVERT_TIMEOUT, &std::env::temp_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "legacy-convert-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 造一个假 `soffice`（Unix），行为按 `mode`：ok / fail / sleep / garbage / silent。
    ///
    /// ⚠️ **把"记参数的文件"写死在脚本里**，不走环境变量：`std::env::set_var` 是**进程级**的，
    /// 而 cargo 的测试是**多线程并行** ⇒ 两个用例会互相覆盖彼此的环境变量（我第一版就这么假红过：
    /// 有的用例读到别人的路径、有的甚至跑成了另一个用例的脚本行为）。判据之间**不许有共享可变状态**。
    /// ⚠️ **脚本里的字节一律用 POSIX 八进制转义 `\ooo`，不许用 `\xHH`**（2026-09-23 CI 实测红）：
    /// `\xHH` 是 **bash 的扩展**，而 Ubuntu 的 `/bin/sh` 是 **dash**（macOS 的是 bash）——
    /// dash 的 `printf` 不认 `\x03`，**原样输出字面字符**，于是 `printf 'PK\x03\x04fake-ooxml'`
    /// 得到的是 20 字节的 `PK\x03\x04fake-ooxml` 字面串（不是 zip），
    /// `convert_with` 如实以「产出的不是 OOXML 容器（20 字节，前 4 字节不是 zip 魔数）」拒绝
    /// ⇒ 这条 `#[cfg(unix)]` 的判据**在 macOS 绿、在 Linux CI 红**（Windows 上因 `cfg(unix)` 根本不跑）。
    /// 实测（WSL dash）：`\x03\x04` ⇒ `50 4b 5c 78 30 33 5c 78 30 34 …`（20 字节）；
    /// `\003\004` ⇒ `50 4b 03 04 …`（14 字节）✓。
    #[cfg(unix)]
    fn fake_soffice(dir: &Path, mode: &str, args_file: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("soffice");
        let script = format!(
            r#"#!/bin/sh
printf '%s\n' "$@" > "{args}"
outdir=""
prev=""
for a in "$@"; do if [ "$prev" = "--outdir" ]; then outdir="$a"; fi; prev="$a"; done
case "{mode}" in
  ok) printf 'PK\003\004fake-ooxml' > "$outdir/input.docx" ;;
  fail) echo "Error: source file could not be loaded" >&2; exit 3 ;;
  sleep) sleep 5 ;;
  garbage) printf 'not a zip at all' > "$outdir/input.docx" ;;
  silent) : ;;
esac
exit 0
"#,
            args = args_file.display()
        );
        fs::write(&p, script).unwrap();
        let mut perm = fs::metadata(&p).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&p, perm).unwrap();
        p
    }

    #[test]
    fn target_ext_only_accepts_the_three_ooxml_targets() {
        assert_eq!(
            target_ext_for("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Some("docx")
        );
        assert_eq!(target_ext_for("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), Some("xlsx"));
        assert_eq!(
            target_ext_for("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Some("pptx")
        );
        assert_eq!(target_ext_for("application/pdf"), None);
        assert_eq!(target_ext_for(""), None);
    }

    #[test]
    fn source_ext_is_derived_from_the_target() {
        assert_eq!(source_ext_for("docx"), "doc");
        assert_eq!(source_ext_for("xlsx"), "xls");
        assert_eq!(source_ext_for("pptx"), "ppt");
    }

    #[test]
    fn zip_container_check_separates_ooxml_from_garbage() {
        assert!(is_zip_container(&[0x50, 0x4b, 0x03, 0x04, 0x00]));
        assert!(!is_zip_container(b"not a zip"));
        assert!(!is_zip_container(&[0x50, 0x4b]));
    }

    #[test]
    fn pick_first_existing_takes_the_first_present_one() {
        let dir = tmp();
        let a = dir.join("nope");
        let b = dir.join("yes");
        fs::write(&b, b"x").unwrap();
        let got = pick_first_existing(&[a.clone(), b.clone()], |p| p.exists());
        assert_eq!(got, Some(b));
        assert_eq!(pick_first_existing(&[a], |p| p.exists()), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn convert_passes_the_expected_argv_and_returns_bytes_on_success() {
        let dir = tmp();
        let args_file = dir.join("args.txt");
        let bin = fake_soffice(&dir, "ok", &args_file);
        let out = convert_with(&bin, b"old-bytes", "docx", Duration::from_secs(5), &dir).unwrap();
        assert!(out.starts_with(&[0x50, 0x4b, 0x03, 0x04]), "应当回转换后的字节");
        let args = fs::read_to_string(&args_file).unwrap();
        assert!(args.contains("--headless"), "argv 里要有 --headless：{args}");
        assert!(args.contains("--convert-to"), "argv 里要有 --convert-to：{args}");
        assert!(args.contains("docx"), "argv 里要有目标格式：{args}");
        assert!(args.contains("--outdir"), "argv 里要有 --outdir：{args}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn convert_reports_a_nonzero_exit_with_the_childs_own_words() {
        let dir = tmp();
        let bin = fake_soffice(&dir, "fail", &dir.join("args.txt"));
        let err = convert_with(&bin, b"x", "docx", Duration::from_secs(5), &dir).unwrap_err();
        assert!(err.contains("非零状态"), "要说明是非零退出：{err}");
        assert!(err.contains("could not be loaded"), "要带上子进程的原话（诊断就在这里）：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn convert_rejects_output_that_is_not_an_ooxml_container() {
        let dir = tmp();
        let bin = fake_soffice(&dir, "garbage", &dir.join("args.txt"));
        let err = convert_with(&bin, b"x", "docx", Duration::from_secs(5), &dir).unwrap_err();
        assert!(err.contains("不是 OOXML 容器"), "垃圾输出必须被拒：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn convert_reports_missing_output() {
        let dir = tmp();
        let bin = fake_soffice(&dir, "silent", &dir.join("args.txt"));
        let err = convert_with(&bin, b"x", "docx", Duration::from_secs(5), &dir).unwrap_err();
        assert!(err.contains("没有产出"), "没产出要说清：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn convert_times_out_kills_the_child_and_cleans_the_temp_dir() {
        let root = tmp();
        let bin = fake_soffice(&root, "sleep", &root.join("args.txt"));
        let started = Instant::now();
        let err = convert_with(&bin, b"x", "docx", Duration::from_millis(300), &root).unwrap_err();
        assert!(err.contains("超时"), "要报超时：{err}");
        assert!(started.elapsed() < Duration::from_secs(4), "超时要真的生效（别等子进程自己结束）");
        // ★ 临时目录必须被清掉：这是"跑久了不会堆满临时件"的判据
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("shuyonote-legacy-"))
            .collect();
        assert!(leftovers.is_empty(), "超时后临时目录没清：{leftovers:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn command_rejects_an_unknown_target_before_touching_the_filesystem() {
        let err = convert_legacy_office(vec![1, 2, 3], "application/pdf".into()).unwrap_err();
        assert!(err.contains("不支持的目标格式"), "不认识的目标要当场拒：{err}");
    }

    #[test]
    fn missing_soffice_message_names_what_to_install() {
        assert!(SOFFICE_MISSING.contains("LibreOffice"));
        assert!(SOFFICE_MISSING.contains("brew") || SOFFICE_MISSING.contains("apt"), "要给出装法");
    }
}
