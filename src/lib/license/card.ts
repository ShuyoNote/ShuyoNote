// 许可证（卡）的**解析与五态** —— 只做格式层，⛔ 不验签（验签在 Rust 侧 `relay_license.rs`，
// 与中继共用同一份实现是那边的既定口径 ✓；本文件只负责"读得出/判得准/挑得对"）。
//
// 口径来源（只读规格，⛔ 不拷实现）：
//   - `shuyonote-relay/docs/specs/2026-10-02-license-format-spec.md` §2/§3/§4/§9
//   - 本仓 `src-tauri/src/relay_license.rs` 的常量（容差 600s、`crossnet` 能力位）
//
// ## 三条最容易被写错的（本文件就是为了把它们钉死）
// ① **停卡 ≠ 过期**：`cap` 里没有 `crossnet` ⇒ `stopped`（退款/停卡签的就是"立即生效 + cap 为空"）。
//    界面 ⛔ 不许写"已过期"，必须写「已停卡 · 只停了跨网」。
// ② **±10 分钟容差**：`now < nbf - 600` 才算"还没生效"；容差内**算有效**。
// ③ **挑当前代看 `rot`（同 rot 看 `iat`）**，⛔ 不看 `exp` —— 停卡那张的 `exp` 与旧卡一样，
//    按 `exp` 挑会把新代（停卡）挑丢、然后拿旧卡说"还有效"。
import type { LicenseClaims } from "./types";

/** 与 Rust 侧 `CLOCK_TOLERANCE_SECS` 同一个数（⛔ 两处各写一个数字就是两份真相）。 */
export const CLOCK_TOLERANCE_SECS = 600;
/** 缺省宽限天数（Rust `DEFAULT_GRACE_DAYS`）。 */
export const DEFAULT_GRACE_DAYS = 14;
/** 唯一的能力位（§3：将来加位要**加**，不改语义）。 */
export const CROSSNET_CAP = "crossnet";

export const CARD_PREFIX = "SHUYO-LIC-";
export const CARD_VERSION = 1;

/** 读不出来的四档（与规格 §10 的码一一对应）。 */
export type ParseError = "MALFORMED" | "VERSION" | "UNKNOWN_KID";

export type ParseResult =
  | { ok: true; payload: LicenseClaims; payloadB64: string; sigB64: string }
  | { ok: false; error: ParseError };

export type CardState = "active" | "grace" | "expired" | "not-yet" | "stopped";

const B64URL = /^[A-Za-z0-9_-]+$/;

/** base64url（无填充）→ 字节；形状不对 ⇒ `null`（⛔ 不抛，调用方要能把它当 MALFORMED）。 */
function b64urlToBytes(s: string): Uint8Array | null {
  if (!B64URL.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** UTF-8 字节 → 文本（形状不对 ⇒ `null`）。 */
function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * 解析一张卡。
 *
 * ⚠️ **版本号在最外层**（`SHUYO-LIC-2.…`）⇒ 老客户端读到新版本要报 `VERSION`（"请升级客户端"），
 *    ⛔ 不许当成 `MALFORMED`/`BAD_SIG`（那会让用户以为卡坏了）。
 */
export function parseCard(text: string): ParseResult {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "MALFORMED" };

  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, error: "MALFORMED" };
  const [head, payloadB64, sigB64] = parts;

  if (!head.startsWith(CARD_PREFIX)) return { ok: false, error: "MALFORMED" };
  const ver = head.slice(CARD_PREFIX.length);
  if (!/^\d+$/.test(ver)) return { ok: false, error: "MALFORMED" };
  if (Number(ver) !== CARD_VERSION) return { ok: false, error: "VERSION" };

  const payloadBytes = b64urlToBytes(payloadB64);
  if (!payloadBytes) return { ok: false, error: "MALFORMED" };
  const sigBytes = b64urlToBytes(sigB64);
  if (!sigBytes || sigBytes.length !== 64) return { ok: false, error: "MALFORMED" };

  const json = utf8(payloadBytes);
  if (json === null) return { ok: false, error: "MALFORMED" };
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: "MALFORMED" };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: "MALFORMED" };
  }

  // 必填字段（§3 未标"可"者必填）；形状不认识 ⇒ MALFORMED（⛔ 不猜、不补默认值）
  if (obj.v !== CARD_VERSION) return { ok: false, error: obj.v === undefined ? "MALFORMED" : "VERSION" };
  if (obj.typ !== "card" && obj.typ !== "bundle" && obj.typ !== "trial") return { ok: false, error: "MALFORMED" };
  if (!isStr(obj.sub) || !isStrArr(obj.dev) || !isInt(obj.seats)) return { ok: false, error: "MALFORMED" };
  if (!isInt(obj.nbf) || !isInt(obj.exp) || !isInt(obj.iat)) return { ok: false, error: "MALFORMED" };
  if (!isInt(obj.grace) || !isStr(obj.kid) || !isStr(obj.jti)) return { ok: false, error: "MALFORMED" };
  if (!isStrArr(obj.cap) || !isInt(obj.rot)) return { ok: false, error: "MALFORMED" };
  if (obj.prev !== undefined && obj.prev !== null && !isStr(obj.prev)) return { ok: false, error: "MALFORMED" };
  if (obj.exp <= obj.nbf) return { ok: false, error: "MALFORMED" };
  if (obj.dev.length > obj.seats) {
    // §10：`SEATS` 是**签发侧**的错 —— 这里用 MALFORMED 之外的专门码会更准，
    // 但客户端的动作一样（"联系发卡方"），所以由调用方按 MALFORMED 的话术处理。
    return { ok: false, error: "MALFORMED" };
  }

  const payload: LicenseClaims = {
    v: obj.v,
    typ: obj.typ,
    sub: obj.sub,
    dev: obj.dev,
    seats: obj.seats,
    nbf: obj.nbf,
    exp: obj.exp,
    grace: obj.grace,
    kid: obj.kid,
    iat: obj.iat,
    jti: obj.jti,
    cap: obj.cap,
    rot: obj.rot,
    ...(typeof obj.prev === "string" ? { prev: obj.prev } : {}),
  };
  return { ok: true, payload, payloadB64, sigB64 };
}

/**
 * 这张卡**现在**处于哪一态。
 *
 * 判定顺序（顺序本身是口径，别调换）：
 * 1. `cap` 里没有 `crossnet` ⇒ **stopped**（停卡；⛔ 不因为"过期了"就改报 expired ✗ ——
 *    细则：停卡是**签发方主动**的结果，用户要看到的是"只停了跨网"，不是"你过期了"）；
 * 2. `now < nbf - 容差` ⇒ **not-yet**（"还没到生效时间"，⛔ 不是"无效" ✗）；
 * 3. `now <= exp + 容差` ⇒ **active**；
 * 4. `now <= exp + grace*86400 + 容差` ⇒ **grace**；
 * 5. 否则 ⇒ **expired**。
 */
export function cardState(payload: LicenseClaims, nowSec: number): CardState {
  const tol = CLOCK_TOLERANCE_SECS;
  if (!payload.cap.includes(CROSSNET_CAP)) return "stopped";
  if (nowSec < payload.nbf - tol) return "not-yet";
  if (nowSec <= payload.exp + tol) return "active";
  const graceEnd = payload.exp + Math.max(0, payload.grace) * 86_400 + tol;
  if (nowSec <= graceEnd) return "grace";
  return "expired";
}

/** 这一态下**跨网**还可用吗（本机永远可用 —— 那是产品铁律，不在这个函数里表达）。 */
export function crossnetAllowed(state: CardState): boolean {
  return state === "active" || state === "grace";
}

/**
 * 多代并存时挑**当前那张**：`rot` 大的优先，同 `rot` 取 `iat` 大的。
 *
 * ⚠️ ⛔ 不要按 `exp` 挑 —— 停卡那张（新代）的 `exp` 与旧卡**一样**，按 `exp` 会挑到旧的，
 *    然后把"已停卡"读成"仍有效" ✗（这是规格里点名的那条坑）。
 * ⚠️ 只比较**解析得出来**的卡（坏卡不参与挑选，但也不该拖垮别的卡）。
 */
export function pickCurrent<T extends { payload: LicenseClaims }>(cards: T[]): T | null {
  if (cards.length === 0) return null;
  return cards.reduce((best, cur) => {
    if (cur.payload.rot !== best.payload.rot) return cur.payload.rot > best.payload.rot ? cur : best;
    return cur.payload.iat > best.payload.iat ? cur : best;
  });
}

/** 剩余天数（向上取整到"天"，仅 active/grace 有意义；其它态给 0）。 */
export function daysLeft(payload: LicenseClaims, nowSec: number): number {
  const end = payload.exp + Math.max(0, payload.grace) * 86_400;
  return Math.max(0, Math.ceil((end - nowSec) / 86_400));
}
