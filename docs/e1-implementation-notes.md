# E1 本地静置加密 — 实现进度与接续笔记

> 目标:口令→Argon2id→密钥**只存会话内存(不落盘)**;启动默认锁定、口令解锁门控(锁定态不同步/不读);用 **SQLCipher 加密每个工作空间库 `spaces/*.db` 与附件**;重启默认锁定、解锁前数据不可读。

## 已完成的(已验证)
- **会话密钥不落盘**(`security.rs`):`SESSION_KEY`(会话内存);`set_encryption`/`unlock_encryption` 装会话、`lock`/`disable` 清空;**不再持久化 `ENC_KEY`**。编译通过。
- **启动即锁定**(`lib.rs`):调用 `security::startup_lock`——若已开启加密,启动即 `LOCKED=true`。
- **口令解锁门控**:`sync_gate`(锁定态拒绝同步);前端 `ThemeSettings` 已有开启/锁定/解锁/关闭 UI。
- **SQLCipher 能力验证**(`security.rs` `sqlcipher_roundtrip` 测试):加密库→同 key 读回→错 key 失败,通过;并暴露 `session_key()`。

## 工作区当前(未提交,接续时保留)
- `src-tauri/Cargo.toml`:rusqlite features 已改为 `bundled-sqlcipher`(构建需设 OpenSSL 变量,见下)。
- `src-tauri/src/security.rs`:新增 `session_key()` + `sqlcipher_roundtrip` 测试(依赖 `bundled-sqlcipher`;若 main 保持 `bundled` 则此测试会因 `PRAGMA key` 缺失而失败)。

> ⚠️ 不要单独把 `security.rs` 提交到 main:main 的 `Cargo.toml` 还是 `bundled`(无 sqlcipher),该测试会 `cargo test` 失败。要么和 `Cargo.toml`(bundled-sqlcipher)一起提交,要么保持在工作区。当前保持工作区未提交,main 可独立构建(`bundled`)。

## 待办(新会话顺序)
1. **启动解锁门控 + 前端解锁**:避免「库已加密但会话锁定 → 应用无法启动」(active 空间库在启动时打开,若已加密需先解锁)。
2. **per-space 加密标记**:哪些 `spaces/*.db` 已加密(可在 meta.db 记录)。
3. **db.rs 打开点**:`reopen_space`、`open_space_conn`、启动 `setup` 的 active 空间库——已加密且有会话密钥→设 `PRAGMA key`;未加密→明文读取(当前所有库未加密,加入逻辑后现有数据不受影响)。
4. **开启加密时的迁移**:把现有明文 `spaces/*.db` 用 SQLCipher 重加密并标记(ATTACH/export 方式),再启用加密标记。

> 建议先做 1,再做 3,最后 4(迁移);每步隔离验证(先用测试库/隔离环境验证加解密+迁移往返),不要直接动真实库。

## 构建前提(编译需要)
系统 OpenSSL 已装,编译时设:
```
OPENSSL_DIR=C:\Program Files\OpenSSL-Win64
OPENSSL_LIB_DIR=C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD
OPENSSL_INCLUDE_DIR=C:\Program Files\OpenSSL-Win64\include
```

## 相关提交
- `9b8d0d1` E1 第一步(会话密钥 + 启动即锁定)。此后 `security.rs`/`Cargo.toml` 的改动在工作区(未提交,接续时对齐上面说明)。
