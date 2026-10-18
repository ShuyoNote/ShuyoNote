//! 本机**设备身份**：一把 ed25519 私钥 ＋ 由公钥派生的 `dev` 令牌。
//!
//! ## 三条硬规矩（每条都对应一次真实后果）
//! ① **`dev` 只从公钥派生**：`dev-` ＋ `sha256(pubkey)` 的**前 16 位十六进制**（⛔ 不采硬件明细 ✗）。
//!    ⇒ 同一把私钥换台机器也是同一个 `dev`（换机会由发卡站签新一代卡，见格式规格 §6）。
//! ② **私钥文件坏了 ⇒ 明确报错，⛔ 绝不悄悄换一把新的** ✗ ——
//!    换了新钥匙 ⇒ 旧卡的 `dev` 名单对不上 ⇒ **那张卡再也续不了**，而用户只看到"续期失败"。
//! ③ **落盘先写临时再 rename**（同目录 ⇒ 同卷，rename 原子）＋ `0600`。
//!
//! ## 为什么没有"系统钥匙串"
//! 这个仓没有引入钥匙串 crate（多一个平台依赖就多一处构建风险）。
//! 现状是**文件 + 收窄权限**：unix 上 `0600`；Windows 没有等价的 `0600`，
//! 依赖 `%APPDATA%` 本身是**用户私有目录**这一事实（⚠️ 如实写在注释里，不假装有钥匙串）。
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

/// 私钥种子（32 字节）的落盘文件名（内容是 **hex**，一行）。
const KEY_FILE: &str = "identity.hex";
/// 设备目录（相对 app data）。
const DEVICE_DIR: &str = "device";

pub struct DeviceIdentity {
    signing: SigningKey,
}

impl DeviceIdentity {
    /// `dev` 令牌：`dev-` ＋ `sha256(pubkey)` 前 16 位 hex。
    pub fn dev(&self) -> String {
        dev_token(&self.signing.verifying_key().to_bytes())
    }

    /// 公钥的 base64url（下单接口的 `pubkey` 字段用它，与发卡站 `--dev <dev>=<pubkey b64url>` 同口径）。
    pub fn public_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.signing.verifying_key().to_bytes())
    }

    /// 对**调用方给出的字节**签名，返回 base64url。
    ///
    /// ⚠️ 被签名的四条字节由前端 `src/lib/license/signedBytes.ts` 拼装（**只此一处**布局）；
    /// 本函数只做"签"，⛔ 不自己拼串 ✗ —— 否则那份布局就有两份实现。
    pub fn sign_b64(&self, payload: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.signing.sign(payload.as_bytes()).to_bytes())
    }

    #[cfg(test)]
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self { signing: SigningKey::from_bytes(&seed) }
    }
}

/// `dev-` ＋ `sha256(pubkey)` 前 16 位 hex（纯函数 ⇒ 判据直接喂公钥）。
pub fn dev_token(pubkey: &[u8; 32]) -> String {
    let h = Sha256::digest(pubkey);
    format!("dev-{}", hex::encode(&h[..8]))
}

fn device_dir(app_data: &Path) -> PathBuf {
    app_data.join(DEVICE_DIR)
}

fn key_path(app_data: &Path) -> PathBuf {
    device_dir(app_data).join(KEY_FILE)
}

/// 读或**首次**创建本机身份。
///
/// 读不出来（内容不是 64 位 hex／文件不可读）⇒ `Err`，**不生成新的**。
pub fn load_or_create(app_data: &Path) -> Result<DeviceIdentity, String> {
    let path = key_path(app_data);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let seed = parse_seed(text.trim())?;
            Ok(DeviceIdentity { signing: SigningKey::from_bytes(&seed) })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let identity = generate();
            write_seed(&path, identity.signing.to_bytes())?;
            Ok(identity)
        }
        Err(e) => Err(format!(
            "读不到设备私钥（{path:?}：{e}）。⛔ 不会自动换一把新的 —— 换了旧卡就再也续不了；\
             请从备份恢复这个文件，或联系我们重建设备身份"
        )),
    }
}

fn parse_seed(text: &str) -> Result<[u8; 32], String> {
    if text.len() != 64 {
        return Err(format!(
            "设备私钥文件损坏（长度 {}，应为 64 位 hex）。⛔ 不会自动换一把新的 —— \
             换了旧卡就再也续不了；请从备份恢复",
            text.len()
        ));
    }
    let bytes = hex::decode(text).map_err(|_| {
        "设备私钥文件损坏（不是十六进制）。⛔ 不会自动换一把新的 —— 换了旧卡就再也续不了；请从备份恢复"
            .to_string()
    })?;
    let mut seed = [0u8; 32];
    if bytes.len() != 32 {
        return Err("设备私钥文件损坏（不是 32 字节）。⛔ 不会自动换一把新的".to_string());
    }
    seed.copy_from_slice(&bytes);
    Ok(seed)
}

fn generate() -> DeviceIdentity {
    use rand_core::RngCore as _;
    let mut seed = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut seed);
    DeviceIdentity { signing: SigningKey::from_bytes(&seed) }
}

/// 先写 `.tmp` 再 rename（原子）＋ 收窄权限。
fn write_seed(path: &Path, seed: [u8; 32]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了设备目录：{e}"))?;
    }
    let tmp = path.with_extension("hex.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("写不了临时私钥文件：{e}"))?;
        f.write_all(hex::encode(seed).as_bytes())
            .map_err(|e| format!("写不了临时私钥文件：{e}"))?;
        f.sync_all().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("落盘私钥失败：{e}"))?;
    Ok(())
}

/// 从 app data 里取本机身份（命令层用；拿不到 app data ⇒ 明确报错）。
///
/// ⚠️ 走 `db::app_data_dir_ref()`（那是 app data 的**唯一出口**），⛔ 不自己读环境变量 ✗。
pub fn load_default() -> Result<DeviceIdentity, String> {
    let dir = crate::db::app_data_dir_ref().ok_or_else(|| "app data dir 还没初始化".to_string())?;
    load_or_create(dir)
}

/// 公钥字节 → 一个可给人抄的短指纹（界面显示"这台设备"用，⛔ 不是 `dev` 的替代）。
pub fn fingerprint(pubkey: &VerifyingKey) -> String {
    let h = Sha256::digest(pubkey.to_bytes());
    hex::encode(&h[..8])
}

// ── 命令层（薄壳：算法都在上面；命令只做"读身份 / 签字节"）──────────────────────────

/// 本机设备身份：`{ dev, pubkey }`（`pubkey` 是 base64url，下单接口直接用它）。
#[tauri::command]
pub fn license_device() -> Result<serde_json::Value, String> {
    let id = load_default()?;
    Ok(serde_json::json!({ "dev": id.dev(), "pubkey": id.public_b64() }))
}

/// 用本机私钥签**调用方给的字节**（被签名的四条字节由前端拼，⛔ 这里不拼）。
#[tauri::command]
pub fn license_sign(payload: String) -> Result<String, String> {
    Ok(load_default()?.sign_b64(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_token_is_derived_from_pubkey_only() {
        let id = DeviceIdentity::from_seed([7u8; 32]);
        let dev = id.dev();
        assert!(dev.starts_with("dev-"));
        assert_eq!(dev.len(), 4 + 16);
        // 同一把种子 ⇒ 同一个 dev（换机器也一样：只看公钥）
        assert_eq!(dev, DeviceIdentity::from_seed([7u8; 32]).dev());
        assert_ne!(dev, DeviceIdentity::from_seed([8u8; 32]).dev());
    }

    #[test]
    fn corrupt_key_file_is_a_hard_error_not_a_regenerate() {
        let dir = std::env::temp_dir().join(format!("devid-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(DEVICE_DIR)).unwrap();
        std::fs::write(dir.join(DEVICE_DIR).join(KEY_FILE), "not-a-hex-seed").unwrap();
        let err = match load_or_create(&dir) {
            Ok(_) => panic!("损坏的私钥文件必须报错（⛔ 不许悄悄换新）"),
            Err(e) => e,
        };
        assert!(err.contains("不会自动换一把新的"), "报错要说清后果：{err}");
        // 文件没被覆盖
        let after = std::fs::read_to_string(dir.join(DEVICE_DIR).join(KEY_FILE)).unwrap();
        assert_eq!(after, "not-a-hex-seed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_once_then_reloads_the_same_identity() {
        let dir = std::env::temp_dir().join(format!("devid-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_or_create(&dir).unwrap();
        let b = load_or_create(&dir).unwrap();
        assert_eq!(a.dev(), b.dev());
        assert_eq!(a.public_b64(), b.public_b64());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
