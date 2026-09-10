// BLAKE2b-512（RFC 7693），仅用于发布前校验 Tauri 更新签名。
//
// 为什么要自己实现：Tauri 的 `.sig` 是 minisign 格式，且用的是**预哈希模式**（签名
// blob 的算法标识为 `ED`）——即先对文件整体做 BLAKE2b-512，再对该摘要做 ed25519。
// 而 Node 的 crypto 没有 blake2b（`crypto.getHashes()` 里没有；OpenSSL 3 把 blake2
// 归到未默认加载的 provider）。ed25519 部分 Node 有，缺的只有这个摘要，于是自己补。
//
// 为什么值得做：`.sig` 与安装包一旦不是同一次构建的一对（手工从两次 run 里各取一个、
// 或 bundle 目录里留着同名旧产物），**发布阶段毫无察觉、用户更新时才发现校验失败**——
// 这是更新通道最难查的一类事故。校验摘要能把它拦在发布前。
//
// 实现说明：64 位字拆成 hi/lo 两个 32 位数组（不用 BigInt——大文件要跑几百万个分组，
// BigInt 慢一个数量级）。流式处理，内存固定 128 字节，不整读文件。正确性由 RFC 7693
// 向量与「线上真实签名的三对产物必须全部通过」共同钉住（见 releaseArtifacts.test.mjs）。

const IV_HI = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const IV_LO = new Uint32Array([
  0xf3bcc908, 0x84caa73b, 0xfe94f82b, 0x5f1d36f1, 0xade682d1, 0x2b3e6c1f, 0xfb41bd6b, 0x137e2179,
]);

// prettier-ignore
const SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
]);

const BLOCK = 128;
const MASK = 0xffffffff;

/** 无密钥 BLAKE2b-512 的流式实现（update 可多次调用）。 */
export class Blake2b512 {
  constructor() {
    this.hHi = new Uint32Array(IV_HI);
    this.hLo = new Uint32Array(IV_LO);
    this.hLo[0] = (this.hLo[0] ^ 0x01010040) >>> 0; // 参数块：摘要 64 字节、无密钥
    this.count = 0; // 已压缩字节数（含最后一块）
    this.buf = new Uint8Array(BLOCK);
    this.buflen = 0;
    this.vHi = new Uint32Array(16);
    this.vLo = new Uint32Array(16);
    this.mHi = new Uint32Array(16);
    this.mLo = new Uint32Array(16);
  }

  update(chunk) {
    let off = 0;
    while (off < chunk.length) {
      // 缓冲满且后面还有数据 → 立即压缩；最后一块必须留到 digest()，因为只有它带
      // final 标志（长度恰为 128 整数倍时，这正是唯一正确的处理）。
      if (this.buflen === BLOCK) {
        this.count += BLOCK;
        this.#compress(false);
        this.buflen = 0;
      }
      const n = Math.min(BLOCK - this.buflen, chunk.length - off);
      this.buf.set(chunk.subarray(off, off + n), this.buflen);
      this.buflen += n;
      off += n;
    }
    return this;
  }

  digest() {
    this.count += this.buflen;
    this.buf.fill(0, this.buflen);
    this.#compress(true);
    const out = Buffer.allocUnsafe(64);
    for (let w = 0; w < 8; w++) {
      out.writeUInt32LE(this.hLo[w], w * 8); // 64 位小端：先 lo 后 hi
      out.writeUInt32LE(this.hHi[w], w * 8 + 4);
    }
    return out;
  }

  #compress(final) {
    const { hHi, hLo, vHi, vLo, mHi, mLo, buf } = this;
    for (let i = 0; i < 16; i++) {
      mLo[i] = (buf[i * 8] | (buf[i * 8 + 1] << 8) | (buf[i * 8 + 2] << 16) | (buf[i * 8 + 3] << 24)) >>> 0;
      mHi[i] = (buf[i * 8 + 4] | (buf[i * 8 + 5] << 8) | (buf[i * 8 + 6] << 16) | (buf[i * 8 + 7] << 24)) >>> 0;
    }
    for (let i = 0; i < 8; i++) {
      vHi[i] = hHi[i];
      vLo[i] = hLo[i];
      vHi[i + 8] = IV_HI[i];
      vLo[i + 8] = IV_LO[i];
    }
    // 128 位计数器：只用低 64 位（tLo/tHi），高 64 位恒为 0
    vLo[12] = (vLo[12] ^ (this.count % 4294967296)) >>> 0;
    vHi[12] = (vHi[12] ^ Math.floor(this.count / 4294967296)) >>> 0;
    if (final) {
      vHi[14] = (vHi[14] ^ MASK) >>> 0;
      vLo[14] = (vLo[14] ^ MASK) >>> 0;
    }
    for (let r = 0; r < 12; r++) {
      const s = (r % 10) * 16;
      // 参数是**状态字下标**（0..15），x/y 是**消息字下标**
      g(this, 0, 4, 8, 12, SIGMA[s], SIGMA[s + 1]);
      g(this, 1, 5, 9, 13, SIGMA[s + 2], SIGMA[s + 3]);
      g(this, 2, 6, 10, 14, SIGMA[s + 4], SIGMA[s + 5]);
      g(this, 3, 7, 11, 15, SIGMA[s + 6], SIGMA[s + 7]);
      g(this, 0, 5, 10, 15, SIGMA[s + 8], SIGMA[s + 9]);
      g(this, 1, 6, 11, 12, SIGMA[s + 10], SIGMA[s + 11]);
      g(this, 2, 7, 8, 13, SIGMA[s + 12], SIGMA[s + 13]);
      g(this, 3, 4, 9, 14, SIGMA[s + 14], SIGMA[s + 15]);
    }
    for (let i = 0; i < 8; i++) {
      hHi[i] = (hHi[i] ^ vHi[i] ^ vHi[i + 8]) >>> 0;
      hLo[i] = (hLo[i] ^ vLo[i] ^ vLo[i + 8]) >>> 0;
    }
  }
}

// G(a, b, c, d)，四步混合；x/y 为消息字下标
function g(st, a, b, c, d, x, y) {
  const { vHi, vLo, mHi, mLo } = st;
  add(vHi, vLo, a, b);
  addMsg(vHi, vLo, a, mHi[x], mLo[x]);
  vHi[d] = (vHi[d] ^ vHi[a]) >>> 0;
  vLo[d] = (vLo[d] ^ vLo[a]) >>> 0;
  rotr(vHi, vLo, d, 32);
  add(vHi, vLo, c, d);
  vHi[b] = (vHi[b] ^ vHi[c]) >>> 0;
  vLo[b] = (vLo[b] ^ vLo[c]) >>> 0;
  rotr(vHi, vLo, b, 24);
  add(vHi, vLo, a, b);
  addMsg(vHi, vLo, a, mHi[y], mLo[y]);
  vHi[d] = (vHi[d] ^ vHi[a]) >>> 0;
  vLo[d] = (vLo[d] ^ vLo[a]) >>> 0;
  rotr(vHi, vLo, d, 16);
  add(vHi, vLo, c, d);
  vHi[b] = (vHi[b] ^ vHi[c]) >>> 0;
  vLo[b] = (vLo[b] ^ vLo[c]) >>> 0;
  rotr(vHi, vLo, b, 63);
}

// dst += src
function add(vHi, vLo, dst, src) {
  const lo = vLo[dst] + vLo[src];
  const hi = vHi[dst] + vHi[src] + (lo >= 4294967296 ? 1 : 0);
  vLo[dst] = lo >>> 0;
  vHi[dst] = hi >>> 0;
}

// dst += (msgHi, msgLo)
function addMsg(vHi, vLo, dst, msgHi, msgLo) {
  const lo = vLo[dst] + msgLo;
  const hi = vHi[dst] + msgHi + (lo >= 4294967296 ? 1 : 0);
  vLo[dst] = lo >>> 0;
  vHi[dst] = hi >>> 0;
}

// 就地 64 位循环右移 n 位（n ∈ 1..63）
function rotr(vHi, vLo, i, n) {
  const hi = vHi[i], lo = vLo[i];
  if (n === 32) {
    vHi[i] = lo;
    vLo[i] = hi;
  } else if (n < 32) {
    vHi[i] = ((hi >>> n) | (lo << (32 - n))) >>> 0;
    vLo[i] = ((lo >>> n) | (hi << (32 - n))) >>> 0;
  } else {
    const m = n - 32; // 先整字交换（= rotr 32），再循环右移 m 位
    vHi[i] = ((lo >>> m) | (hi << (32 - m))) >>> 0;
    vLo[i] = ((hi >>> m) | (lo << (32 - m))) >>> 0;
  }
}

/** 一次性计算 BLAKE2b-512 摘要。 */
export function blake2b512(data) {
  return new Blake2b512().update(data).digest();
}
