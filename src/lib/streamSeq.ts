// 帧 `seq` 的解析与**跳号判定**（L4a/L4b 的**客户端半边**；桌面与 Web 共用一处口径）。
//
// 为什么单独一个模块：**服务端只有一种帧**（`shuyonote-sync-server` 的 `push_frame`；owner
// 2026-09-30 拍 D2 起帧里带 `seq`），而客户端有**两条订阅路**（桌面 = Rust 订流 ＋ 事件，
// Web = 浏览器 fetch 读流）⇒ 判定口径必须**只有一处**，否则就是"两个客户端各解释一遍"
// （本仓最忌的第二种真相）。
//
// ⚠️ 与 Rust 那一份（`src-tauri/src/sync_stream.rs` 的 `frame_seq` / `is_seq_gap`）**逐字对应**：
//    · 读不到 `seq` ⇒ `null`（**不猜**，也不拿 0 冒充 —— 0 与"没有这个字段"同形、含义相反）；
//    · 水位**只许前进**（重复／乱序不倒退）；
//    · **第一帧没有可比对象 ⇒ 不判跳号**（哪怕它 seq 很大）；
//    · 跳号 ＝ `seq > last + 1`（中间可能漏了帧）。
//   ⚠️ 跨语言的这两份实现**没有机器等值判据**：各自语言的单测各钉一半。这句写在这里，
//      免得后人以为改一处会自动同步另一处。

/**
 * 帧 ⇒ `seq`。
 *
 * `raw` 两种形状都收：
 * - **SSE 原文**（`data: {...}`，可能多行 `data:` —— Web 侧切出来的就是它）；
 * - **纯 JSON 载荷**（桌面侧 Rust 已经解过帧，喂进事件里的就是载荷）。
 *
 * 读不到（老服务端没有这个字段 / `ping` / 认不出的帧 / 非 JSON）⇒ `null`。
 */
export function frameSeq(raw: string): number | null {
  const payload = raw.includes("data:")
    ? raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n")
    : raw;
  try {
    const parsed: unknown = JSON.parse(payload);
    const seq = (parsed as { seq?: unknown } | null)?.seq;
    return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

/** 跳号判定。`lastSeq === 0` ＝ 还没收到过带 `seq` 的帧（没有可比对象）。 */
export function isSeqGap(lastSeq: number, seq: number): boolean {
  return lastSeq > 0 && seq > lastSeq + 1;
}

/** 一帧的判定结果。`seq` / `gap` 都用 `number | null`：**读不到就说读不到**。 */
export interface FrameVerdict {
  /** 这一帧带的 `seq`（读不到 ⇒ `null`）。 */
  seq: number | null;
  /** 判定为**跳号**时 = 那个"多出来"的 `seq`；没跳号 ⇒ `null`。 */
  gap: number | null;
  /** 新的水位（只许前进）。 */
  last: number;
}

/**
 * 把一帧并进水位，并回答"它是不是跳号"。
 *
 * ⚠️ 消费方拿到 `gap !== null` ⇒ **立刻拉一次**补漏（不许等下一次事件）；
 *    而没有跳号时**不许**产生"跳号那一次"（否则就成了每帧额外拉）。
 */
export function trackFrame(last: number, raw: string): FrameVerdict {
  const seq = frameSeq(raw);
  if (seq === null) return { seq: null, gap: null, last };
  const gap = isSeqGap(last, seq) ? seq : null;
  return { seq, gap, last: Math.max(last, seq) };
}
