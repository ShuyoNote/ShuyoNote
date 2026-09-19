//! 国密对拍夹具（Linux 侧，2026-09-17 AMD）
//!
//! 目的：把「应用层 RustCrypto」与「库级 Tongsuo」这两份 SM4/SM3 实现的**一致性**变成可执行判据。
//! 依据：`ShuyoNote/docs/plans/2026-09-16-sm-crypto-full-plan.md` §0.1 常量表
//! （套件 SM4-CBC ＋ HMAC-SM3 / EtM；填充 PKCS#7；IV 16B；MAC 覆盖 版本头＋IV＋密文；enc/mac 两把独立密钥）。
//!
//! ⚠️ PBKDF2 的迭代数在 §0-D 里**故意留空**（等压测后写死），所以本夹具**不把迭代数写进断言**。
//!
//! API 口径（实测，别照抄旧文档）：`sm4 0.6` / `cbc 0.2.1` 解析到 **cipher 0.5.2**，
//! 带 padding 的辅助方法是 **`encrypt_padded_vec::<P>()` / `decrypt_padded_vec::<P>()`**（无 `_mut`），
//! 且分别在 **`BlockModeEncrypt` / `BlockModeDecrypt`** 两个 trait 上（不是 `BlockEncryptMut`）。

use cbc::cipher::block_padding::{NoPadding, Pkcs7};
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyInit, KeyIvInit};
use cbc::{Decryptor, Encryptor};
use hmac::{Hmac, Mac};
use sm3::{Digest, Sm3};
use sm4::Sm4;

type HmacSm3 = Hmac<Sm3>;

fn hexb(s: &str) -> Vec<u8> {
    hex::decode(s.trim()).unwrap_or_else(|e| panic!("非法十六进制 {s:?}: {e}"))
}

fn arg(i: usize) -> String {
    std::env::args().nth(i).unwrap_or_else(|| panic!("缺参数 #{i}"))
}

fn read_stdin() -> Vec<u8> {
    use std::io::Read;
    let mut v = Vec::new();
    std::io::stdin().read_to_end(&mut v).expect("read stdin");
    v
}

/// GM/T 0002 SM4 标准向量：key = 明文 = 0123456789abcdeffedcba9876543210 → 期望 681edf34d206965e86b3e94f536e4246
const SM4_STD: &str = "0123456789abcdeffedcba9876543210";
const SM4_STD_CT: &str = "681edf34d206965e86b3e94f536e4246";
/// GM/T 0004 SM3 标准向量：SM3("abc")
const SM3_STD_ABC: &str = "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0";

/// SM4-ECB，无填充（用于标准向量；输入必须是 16 的整数倍）
fn sm4_ecb_nopad(key: &[u8], pt: &[u8]) -> Vec<u8> {
    let enc = ecb::Encryptor::<Sm4>::new_from_slice(key).expect("SM4 key 必须 16 字节");
    enc.encrypt_padded_vec::<NoPadding>(pt)
}

fn sm3(data: &[u8]) -> Vec<u8> {
    let mut h = Sm3::new();
    h.update(data);
    h.finalize().to_vec()
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "vectors" => {
            let key = hexb(SM4_STD);
            let pt = hexb(SM4_STD);
            let ct = hex::encode(sm4_ecb_nopad(&key, &pt));
            println!("sm4-ecb = {ct}");
            println!("exp-ecb = {SM4_STD_CT}");
            println!("sm4-ok  = {}", ct == SM4_STD_CT);
            let h = hex::encode(sm3(b"abc"));
            println!("sm3     = {h}");
            println!("exp-sm3 = {SM3_STD_ABC}");
            println!("sm3-ok  = {}", h == SM3_STD_ABC);
        }
        "sm4-ecb" => {
            let key = hexb(&arg(2));
            let pt = hexb(&arg(3));
            println!("{}", hex::encode(sm4_ecb_nopad(&key, &pt)));
        }
        "sm3" => {
            let a = arg(2);
            let data = if a == "-" { read_stdin() } else { hexb(&a) };
            println!("{}", hex::encode(sm3(&data)));
        }
        "enc" => {
            // enc <key_hex> <iv_hex> <pt_file>  → CBC + PKCS#7，密文十六进制到 stdout
            let key = hexb(&arg(2));
            let iv = hexb(&arg(3));
            let pt = std::fs::read(&arg(4)).expect("读明文文件失败");
            let ct = Encryptor::<Sm4>::new_from_slices(&key, &iv)
                .expect("key/iv 各 16 字节")
                .encrypt_padded_vec::<Pkcs7>(&pt);
            println!("{}", hex::encode(ct));
        }
        "dec" => {
            // dec <key_hex> <iv_hex> <ct_hex_file> → CBC + PKCS#7，明文原始字节到 stdout
            let key = hexb(&arg(2));
            let iv = hexb(&arg(3));
            let ct = hexb(&std::fs::read_to_string(&arg(4)).expect("读密文十六进制失败"));
            let pt = Decryptor::<Sm4>::new_from_slices(&key, &iv)
                .expect("key/iv 各 16 字节")
                .decrypt_padded_vec::<Pkcs7>(&ct)
                .expect("去填充失败（PKCS#7）");
            use std::io::Write;
            std::io::stdout().write_all(&pt).expect("写 stdout 失败");
        }
        "hmac" => {
            // hmac <key_hex> <file> → HMAC-SM3 tag 十六进制
            let key = hexb(&arg(2));
            let data = std::fs::read(&arg(3)).expect("读文件失败");
            // ⚠️ `new_from_slice` 属于 `KeyInit`（digest 0.11），**不在 `Mac` 上**——
            //    写成 `<HmacSm3 as Mac>::new_from_slice` 会报 E0576（已实测）
            let mut m = HmacSm3::new_from_slice(&key).expect("HMAC key");
            m.update(&data);
            println!("{}", hex::encode(m.finalize().into_bytes()));
        }
        _ => {
            eprintln!("未知子命令 {cmd:?}；用法见文件头注释");
            std::process::exit(2);
        }
    }
}
