/**
 * IMAP 邮箱/文件夹名的 **modified UTF-7** 解码（RFC 3501 §5.1.3）。
 *
 * 为什么需要它：IMAP 协议里非 ASCII 的 mailbox 名**只能**用 modified UTF-7 传 ——
 * 形状是 `&` + base64(UTF-16BE) + `-`，而且 base64 字母表里 **用 `,` 代替 `/`**。
 * 于是 QQ / 163 / 企业邮箱的中文文件夹在协议层就是 `&g0l6Pw-` 这个样子；
 * 不解码直接显示，用户看到的就是"乱码混在正常项里"（真实现象：
 * 文件夹下拉里四项是 `&V4NXpPcuTvY-`/`&XfJS…`/`&XfJT0ZAB-`/`&g0l6Pw-`，第五项是本地标签「收件箱」）。
 *
 * ⚠️ **只在显示时用**：回给后端的仍必须是**原始名**（`SELECT` 要的正是协议层名字）。
 * 本函数不改写任何东西，只把"给人看的那一份"变回 UTF-8。
 *
 * 行为边界（宁可不解，也不要抛进渲染）：
 * - 非法 / 截断（`&` 后没有 `-`、base64 含非法字符、尾部多余位非 0、字节数为奇数）⇒ **整体原样返回**；
 * - `&-` 是**字面量 `&`**（RFC 明文规定），不是编码段；
 * - 不含 `&` 的串（`INBOX` / `Sent Items`）原样返回，零成本。
 */
export function decodeImapUtf7(raw: string): string {
  if (!raw || raw.indexOf('&') < 0) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== '&') {
      out += ch;
      i += 1;
      continue;
    }
    const end = raw.indexOf('-', i + 1);
    // 没有收尾 `-` ⇒ 整串视为坏数据（RFC 要求 `&` 必须成对出现）
    if (end < 0) return raw;
    const run = raw.slice(i + 1, end);
    if (run === '') {
      out += '&';
      i = end + 1;
      continue;
    }
    const decoded = decodeRun(run);
    if (decoded === null) return raw;
    out += decoded;
    i = end + 1;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 解一个编码段（未带 `&`/`-`、未补 padding）。任何不合规都返回 `null`。 */
function decodeRun(run: string): string | null {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let k = 0; k < run.length; k += 1) {
    const ch = run[k];
    const v = B64.indexOf(ch === ',' ? '/' : ch); // modified UTF-7 用 `,` 代 `/`
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // 剩余的 1~5 位是补位，必须是 0；剩 6 位说明长度是 4n+1，本身非法
  if (bits >= 6) return null;
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  // UTF-16BE：字节数必须是偶数，否则不是合法的码元序列
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  let out = '';
  for (let k = 0; k < bytes.length; k += 2) {
    out += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
  }
  return out;
}
