# 本地补丁：n0-dns-resolver 0.1.0（只为 iOS）

## 改了什么 ✓
`src/system_config.rs` 两处 cfg 收窄：
· `#[cfg(target_vendor = "apple")]` ⇒ `#[cfg(all(target_vendor = "apple", target_os = "macos"))]`（mod apple / use apple）
· unix 那支的排除条件从 `target_vendor = "apple"` ⇒ `target_os = "macos"`（于是 **iOS 落进 unix 分支**，读 `/etc/resolv.conf`）
⇒ 目的 ✓：iOS 不再编 `apple.rs`（它用 macOS 专属的 `SCDynamicStore`）⇒ 修 `ld: symbol(s) not found: _kSCDynamicStoreUseSessionKeys`

## 来由 ✓
`n0-dns-resolver` ← `iroh-dns 1.3.0` ← 我们（含 `iroh-relay`）⇒ iOS 链接失败。
上游未做 iOS 适配 ✓；`iroh-dns` 也没有可关掉这段的 feature ✓ ⇒ 只能 vendored 打补丁。

## 什么时候可以删掉 ✓
上游 `n0-dns-resolver` 修了 iOS（或 `iroh` 升级到修复版）之后 ⇒ 删掉 `src-tauri/vendor/n0-dns-resolver/`
＋ `src-tauri/Cargo.toml` 里那节 `[patch.crates-io]` ⇒ 回归正常依赖。
