// ★ B=甲（owner 拍板 2026-09-24）：**密文载荷不许当明文处理**。
//
// 背景（口径见 [数据可见边界](../../docs/sync-server-data-boundary.md) §0.5）：
// **个人空间在服务端只落密文**。而**网页版没有钥匙柜**（浏览器里没有 E2EE 能力，见
// [Web 同步边界](../../docs/web-sync-boundary.md)）⇒ 加密的个人空间在 Web 上**根本解不开**。
// 于是只有两条路：**(甲) 明确拒绝并让用户去桌面端**；**(乙) 降级成明文** —— owner 拍的是**甲**。
//
// 为什么需要这个纯函数：同步载荷的**密文形态**是 `base64(magic | version | …)`（`crypto.rs` 的
// `MAGIC = 0x53`、`VERSION_XCHACHA = 1`、`VERSION_SM4 = 2`）。JS 侧原先**不认识**它 ⇒
// 密文会被当成"坏 JSON"，在 `p.id` 上抛一句 `Cannot read properties of null`（看不懂、也没告诉用户
// 该去哪儿）。判别本身是纯函数 ⇒ 独立成模块、独立判据，接线处只负责"认出后拒绝"。

/** 密文头的魔数（与 Rust `crypto::MAGIC` 同一个值：`'S'`）。 */
export const CRYPTO_MAGIC = 0x53;
/** 本侧认识的密文版本（与 Rust 的 `VERSION_XCHACHA` / `VERSION_SM4` 对齐；不认识的版本**不猜**）。 */
const KNOWN_CRYPTO_VERSIONS = new Set([1, 2]);

/** base64 只认标准字符集（明文 JSON 一定含 `{`/`"`，会在这一步就被排除）。 */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 这段 wire 载荷是不是**我们写的密文**。
 *
 * ⚠️ 三条"不猜"（与 Rust 侧 `peek_format` 同一纪律）：
 * · 不是 base64 / 太短 ⇒ `false`（不是密文）；
 * · 魔数不对 ⇒ `false`（可能只是普通 base64 文本）；
 * · 魔数对但**版本不认识** ⇒ `false` —— 这里刻意**不**断言"是密文"：认不出来就不该替调用方下结论，
 *   调用方按"不是密文"走它原来的路（真正的版本拒绝归 Rust 侧那条 `format_supported`）。
 */
export function looksLikeCiphertext(payload: string): boolean {
  const text = (payload ?? "").trim();
  // 长度下限：至少要有 magic ＋ version 两字节的 base64（4 个字符）
  if (text.length < 4 || !BASE64_ONLY.test(text)) return false;
  let head: string;
  try {
    // 只解前 8 个字符（＝最多 6 字节）就够看头了；坏 base64 会抛 ⇒ 当成"不是密文"
    head = atob(text.slice(0, 8));
  } catch {
    return false;
  }
  if (head.length < 2) return false;
  if (head.charCodeAt(0) !== CRYPTO_MAGIC) return false;
  return KNOWN_CRYPTO_VERSIONS.has(head.charCodeAt(1));
}

/** 认出密文时**给用户看的那句话**（单一来源：接线处只 toast/throw 它，不各写一份）。 */
export function ciphertextRefusalMessage(): string {
  return "这个空间是端到端加密的（同步载荷是密文），网页版没有解密钥匙：请在**桌面端**打开这个空间。";
}
