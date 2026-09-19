//! 国密应用层 AEAD：**SM4-CBC ＋ HMAC-SM3（encrypt-then-MAC）**。
//!
//! ⚠️ 本文件**只在 `--features sm-crypto` 下编译**（方案 §0-E）：默认包一个 SM 包都不编，
//! 外部贡献者的前置不变；国密版 `--features sm-crypto` 另发。
//!
//! 口径**不是我定的**，是接口 —— 来源 `docs/plans/2026-09-16-sm-crypto-full-plan.md` §0.1 常量表
//! （表格里每个值都有〔依据〕，改它等于改密文格式，要同步改对拍夹具与验收清单）：
//!
//! | 项 | 值 |
//! |---|---|
//! | 套件 | SM4-CBC ＋ HMAC-SM3（EtM），**不是 GCM/CCM**（§0-B） |
//! | 填充 | PKCS#7（CBC 必需） |
//! | IV | 16 字节随机，随密文存（不保密），同密钥下不复用 |
//! | MAC | HMAC-SM3，tag 32 字节 |
//! | MAC 覆盖 | **版本头 ＋ IV ＋ 密文**；先验后解 |
//! | 密钥 | **两把独立密钥**（加密 / MAC），不得同一个 |
//! | KDF | PBKDF2-HMAC-SM3，盐 16B，输出 64B → 前 32 加密 / 后 32 MAC |
//! | 实现来源 | 应用层 RustCrypto（§0-F）；库级 Tongsuo；**双向对拍是验收项** |
//!
//! 落盘布局（v2）：`magic(1) | version(1)=2 | iv(16) | ct(n) | tag(32)`
//! —— tag 放**尾部**是 EtM 的自然写法（先算完 ct 再算 MAC），且它覆盖的是**前 18+n 字节**
//! （含版本头，§0.1 明写：漏掉版本头会让降级攻击可行）。字符串路径仍整体 base64（§0-A 同一套编码）。
//!
//! ## 两处"方案没写、必须现在钉死"的口径（⚠️ 会影响跨实现对拍，已同步信箱）
//!
//! 1. **SM4 的密钥长度是 16 字节（GM/T 0002），而 §0.1 写的是"前 32 加密"** —— 两者不能同时成立。
//!    这里的取值：KDF 仍按 §0.1 输出 **64 字节**（前 32 归"加密密钥材料"），
//!    但 **SM4 只用这 32 字节的**前 16 字节**（`enc[..SM4_KEY_LEN]`）。多出来的 16 字节不参与运算。
//!    选"截断"而不是"改成输出 48 字节"的理由：§0.1 的输出长度是**两侧对拍用的接口**
//!    （Tongsuo 侧 `PKCS5_PBKDF2_HMAC(..., EVP_sm3(), 64, out)` 逐字节可比），
//!    改长度会让两侧的 64B 输出不再可比；而截断只影响我方怎么取用，**不改变两侧可比的那 64 字节**。
//! 2. **tag 的位置**：§0.1 只写了"覆盖范围"，没写放在哪。这里取**尾部**（见上）。

use crate::crypto::{HEADER_LEN, MAGIC, VERSION_SM4};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyInit, KeyIvInit};
use cbc::{Decryptor, Encryptor};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sm3::Sm3;
use sm4::Sm4;

type HmacSm3 = Hmac<Sm3>;

/// SM4 分组 / 密钥长度（GM/T 0002：128 位分组、128 位密钥）。
pub const SM4_KEY_LEN: usize = 16;
/// IV 长度（§0.1：16 字节随机）。
pub const SM_IV_LEN: usize = 16;
/// HMAC-SM3 tag 长度（§0.1：32 字节）。
pub const SM_TAG_LEN: usize = 32;
/// KDF 输出长度（§0.1：64 字节 → 前 32 加密 / 后 32 MAC）。
pub const SM_KDF_OUT_LEN: usize = 64;

/// PBKDF2-HMAC-SM3 迭代数 —— 方案 §0-D 说"先压测、再写死 ＋ 加门禁断言"。
///
/// **为什么这一条特别要紧**：国密**没有** Argon2 那种内存硬化（§2 已记为确定的安全降级），
/// 迭代数是**唯一**的补偿手段，也最容易被后人随手改小。所以：
///   · 值写死在这一个常量里（不散落在调用点）；
///   · `kdf_rounds_are_the_pinned_value` 断言它，改小会红；
///   · 压测读数记在 `docs/plans/2026-09-16-sm-crypto-full-plan.md` §0-D 与交付说明里。
pub const SM_KDF_ROUNDS: u32 = 200_000;

/// v2 载荷的最小长度：头 ＋ IV ＋ 一个（PKCS#7 保证至少一个）密文块 ＋ tag。
pub const MIN_V2_LEN: usize = HEADER_LEN + SM_IV_LEN + SM4_KEY_LEN + SM_TAG_LEN;

/// PBKDF2-HMAC-SM3 →（加密密钥材料 32B，MAC 密钥 32B）。**口令不落盘，盐由调用方给。**
///
/// 这一对密钥只用于**应用层 AEAD**；SQLCipher 的库级密钥仍然是 `crypto::derive_key`
/// （Argon2id）那条线 —— 库级换 KDF 是 P2-P3（Tongsuo provider）的事，混在一起会让旧库打不开。
pub fn derive_keys(passphrase: &str, salt: &[u8]) -> ([u8; 32], [u8; 32]) {
    let mut out = [0u8; SM_KDF_OUT_LEN];
    pbkdf2::pbkdf2_hmac::<Sm3>(passphrase.as_bytes(), salt, SM_KDF_ROUNDS, &mut out);
    let mut enc = [0u8; 32];
    let mut mac = [0u8; 32];
    enc.copy_from_slice(&out[..32]);
    mac.copy_from_slice(&out[32..]);
    (enc, mac)
}

/// SM4 实际使用的 16 字节密钥（见文件头"口径 1"）。
#[inline]
fn sm4_key(enc_key: &[u8; 32]) -> &[u8] {
    &enc_key[..SM4_KEY_LEN]
}

/// HMAC-SM3 tag，覆盖调用方给的**完整**被保护字节（含版本头，见 §0.1）。
fn tag_of(mac_key: &[u8; 32], covered: &[u8]) -> Result<[u8; SM_TAG_LEN], String> {
    let mut m = HmacSm3::new_from_slice(mac_key).map_err(|e| format!("HMAC-SM3 初始化失败: {e}"))?;
    m.update(covered);
    let mut tag = [0u8; SM_TAG_LEN];
    tag.copy_from_slice(&m.finalize().into_bytes());
    Ok(tag)
}

/// 加密：`magic | 0x02 | iv(16) | SM4-CBC-PKCS7(ct) | HMAC-SM3(32)`。
pub fn encrypt(plaintext: &[u8], enc_key: &[u8; 32], mac_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut iv = [0u8; SM_IV_LEN];
    OsRng.fill_bytes(&mut iv);
    let ct = Encryptor::<Sm4>::new_from_slices(sm4_key(enc_key), &iv)
        .map_err(|_| "SM4 密钥/IV 长度无效".to_string())?
        .encrypt_padded_vec::<Pkcs7>(plaintext);
    let mut out = Vec::with_capacity(HEADER_LEN + SM_IV_LEN + ct.len() + SM_TAG_LEN);
    out.push(MAGIC);
    out.push(VERSION_SM4);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    // 先算后放：MAC 必须覆盖 `magic | version | iv | ct`（§0.1）。
    let tag = tag_of(mac_key, &out)?;
    out.extend_from_slice(&tag);
    Ok(out)
}

/// 解密 v2 载荷。**先验后解**：MAC 不对就**绝不**进入 SM4 解密（§0-B）。
///
/// `blob` 必须是**带完整 v2 头**的整段（`magic | 0x02 | iv | ct | tag`）——
/// 调用方（`crypto::decrypt`）负责认出它，不在这里再嗅一遍版本。
pub fn decrypt(blob: &[u8], enc_key: &[u8; 32], mac_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if blob.len() < MIN_V2_LEN {
        return Err(format!(
            "SM4 密文长度不足：{} 字节 < 下限 {MIN_V2_LEN}",
            blob.len()
        ));
    }
    let body = &blob[..blob.len() - SM_TAG_LEN];
    let tag = &blob[blob.len() - SM_TAG_LEN..];
    // `verify_slice` 是**常量时间**比较（不要手写 `==`：那会把 tag 按字节泄漏出去）。
    let mut m = HmacSm3::new_from_slice(mac_key).map_err(|e| format!("HMAC-SM3 初始化失败: {e}"))?;
    m.update(body);
    m.verify_slice(tag).map_err(|_| {
        "SM4 密文完整性校验失败（HMAC-SM3 不匹配）—— 已按 EtM 拒绝，未做任何解密".to_string()
    })?;
    let iv = &body[HEADER_LEN..HEADER_LEN + SM_IV_LEN];
    let ct = &body[HEADER_LEN + SM_IV_LEN..];
    Decryptor::<Sm4>::new_from_slices(sm4_key(enc_key), iv)
        .map_err(|_| "SM4 密钥/IV 长度无效".to_string())?
        .decrypt_padded_vec::<Pkcs7>(ct)
        .map_err(|_| "SM4 去填充失败（PKCS#7）".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ **迭代数是常量表的一部分**，改小它等于削弱国密唯一的补偿手段（§0-D）。
    /// 这条断言的作用不是"验证 200000 是对的"，而是**让改小它必须显式改这一行**（同时会惊动 review）。
    #[test]
    fn kdf_rounds_are_the_pinned_value() {
        assert_eq!(SM_KDF_ROUNDS, 200_000, "PBKDF2-HMAC-SM3 迭代数被改了 —— §0-D 要求先压测、并同步文档");
        assert!(SM_KDF_ROUNDS >= 100_000, "迭代数低于 10 万没有理由");
    }

    /// GM/T 0002 SM4 标准向量（ECB，单分组无填充）：key = 明文 = `0123…3210` → `681edf34…4246`。
    /// 这条**不经过本文件的 CBC 路径**，是纯粹的"国产算法原语在这台机器上算得对"的自证。
    ///
    /// 刻意**不用 `ecb` crate**：那会为一个测试多引一个只有测试用的包；`Sm4` 本身就实现了
    /// `BlockCipherEncrypt`（单分组），直接用它是同一件事。
    #[test]
    fn sm4_primitive_matches_the_gmt_0002_vector() {
        use cbc::cipher::{Block, BlockCipherEncrypt, BlockSizeUser};
        let key = hex::decode("0123456789abcdeffedcba9876543210").unwrap();
        let pt = hex::decode("0123456789abcdeffedcba9876543210").unwrap();
        let cipher = Sm4::new_from_slice(&key).unwrap();
        assert_eq!(<Sm4 as BlockSizeUser>::block_size(), SM4_KEY_LEN, "SM4 分组应为 16 字节");
        let mut block = Block::<Sm4>::default();
        block.copy_from_slice(&pt);
        cipher.encrypt_block(&mut block);
        assert_eq!(hex::encode(&block[..]), "681edf34d206965e86b3e94f536e4246");
    }

    /// GM/T 0004 SM3 标准向量：`SM3("abc")`。
    #[test]
    fn sm3_primitive_matches_the_gmt_0004_vector() {
        use sm3::Digest;
        let mut h = Sm3::new();
        h.update(b"abc");
        assert_eq!(
            hex::encode(h.finalize()),
            "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
        );
    }

    /// 往返：37 字节明文（**非整块** ⇒ 必然补到 48），专测 PKCS#7 那条路。
    #[test]
    fn roundtrip_covers_padding() {
        let (enc, mac) = derive_keys("pw", &[3u8; 16]);
        let pt = b"ShuyoNote-GM-p1-application-layer-aead";
        assert_eq!(pt.len() % 16 != 0, true, "明文应当不是整块，否则测不到填充");
        let ct = encrypt(pt, &enc, &mac).unwrap();
        assert_eq!(&ct[..HEADER_LEN], &[MAGIC, VERSION_SM4], "v2 必须带 magic+version 头");
        assert_eq!((ct.len() - HEADER_LEN - SM_IV_LEN - SM_TAG_LEN) % 16, 0, "密文应是块整数倍");
        assert_eq!(decrypt(&ct, &enc, &mac).unwrap(), pt);
    }

    /// ★ **EtM：篡改任一处都必须先失败、且不解密**（§0-B / §7）。
    /// 三格分别改：版本头 / IV / 密文 —— 版本头那一格是"漏掉版本头 = 降级攻击可行"的判据。
    #[test]
    fn tampering_anywhere_fails_before_decrypting() {
        let (enc, mac) = derive_keys("pw", &[5u8; 16]);
        let base = encrypt(b"integrity matters", &enc, &mac).unwrap();
        for (what, idx) in [("版本头", 1usize), ("IV", HEADER_LEN + 3), ("密文", HEADER_LEN + SM_IV_LEN + 1)] {
            let mut bad = base.clone();
            bad[idx] ^= 0x01;
            let err = decrypt(&bad, &enc, &mac).unwrap_err();
            assert!(err.contains("完整性校验失败"), "{what} 被改后竟然不是完整性失败：{err}");
        }
        // tag 自己也被保护：改 tag 同样必须先失败。
        let mut bad_tag = base.clone();
        let n = bad_tag.len();
        bad_tag[n - 1] ^= 0x01;
        assert!(decrypt(&bad_tag, &enc, &mac).is_err());
    }

    /// ★ **两把密钥必须独立**（§0-B）：拿 MAC 密钥当加密密钥（或反之）都不该能读通。
    /// 这条守的是"实现里图省事用同一把 key"这种最容易发生的偷工。
    #[test]
    fn encryption_and_mac_keys_are_not_interchangeable() {
        let (enc, mac) = derive_keys("pw", &[7u8; 16]);
        assert_ne!(enc, mac, "KDF 吐出的两把密钥相同 —— 前 32/后 32 的切分被改坏了");
        let ct = encrypt(b"two keys", &enc, &mac).unwrap();
        assert!(decrypt(&ct, &mac, &enc).is_err(), "两把密钥互换后竟然能解开");
    }

    /// 同一明文两次加密 ⇒ **密文不同**（IV 随机），但都能解开。
    #[test]
    fn iv_is_fresh_per_encryption() {
        let (enc, mac) = derive_keys("pw", &[9u8; 16]);
        let a = encrypt(b"same plaintext", &enc, &mac).unwrap();
        let b = encrypt(b"same plaintext", &enc, &mac).unwrap();
        assert_ne!(a, b, "两次加密字节相同 ⇒ IV 复用了");
        assert_eq!(decrypt(&a, &enc, &mac).unwrap(), decrypt(&b, &enc, &mac).unwrap());
    }

    /// KDF 确定性 + 口令/盐都参与：同口令同盐必同结果，换盐或换口令必不同（两把都要看）。
    #[test]
    fn kdf_is_deterministic_and_salt_bound() {
        let a = derive_keys("pw", &[1u8; 16]);
        let b = derive_keys("pw", &[1u8; 16]);
        let c = derive_keys("pw", &[2u8; 16]);
        let d = derive_keys("pw2", &[1u8; 16]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }

    /// **压测读数**（方案 §0-D："先压测、再写死 ＋ 加门禁断言"）。
    ///
    /// 默认不跑（`#[ignore]`）：它测的是**墙钟时间**，放进常规测试会变成 flaky。
    /// 要复现读数就跑：
    /// ```text
    /// cargo test --release --features sm-crypto --lib -- --ignored --nocapture kdf_cost
    /// ```
    /// ⚠️ **必须 `--release`**：debug 下 PBKDF2 慢一个数量级，量出来的数会吓人（第一版就栽在这）。
    #[test]
    #[ignore = "压测读数，非断言；用 --release --ignored 手动跑"]
    fn kdf_cost_reading() {
        use std::time::Instant;
        let salt = [0x5Au8; 16];
        // 老那条（Argon2id）也一起量：**解锁时两条都跑**（legacy 是 SQLCipher 的原始密钥，
        // 国密那条只喂应用层 AEAD），§0-D 的"<1 秒"要按**两条之和**算。
        let t = Instant::now();
        let _ = crate::crypto::derive_key("a-typical-passphrase", &salt).unwrap();
        println!("Argon2id（默认参数）        ：{:8.1} ms", t.elapsed().as_secs_f64() * 1000.0);
        for rounds in [50_000u32, 100_000, 200_000, 400_000] {
            let t = Instant::now();
            let mut out = [0u8; SM_KDF_OUT_LEN];
            pbkdf2::pbkdf2_hmac::<Sm3>(b"a-typical-passphrase", &salt, rounds, &mut out);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            println!("PBKDF2-HMAC-SM3 {rounds:>7} 轮：{ms:8.1} ms  （每 1 万轮 {:.1} ms）", ms / (rounds as f64 / 10_000.0));
        }
        println!("当前常量 SM_KDF_ROUNDS = {SM_KDF_ROUNDS}");
    }
}
