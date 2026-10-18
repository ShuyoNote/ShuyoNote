// 发卡站（license-issuer）三条流程的**请求形状**与薄封装。
//
// 口径来源（只读规格，⛔ 不拷实现）：`shuyonote-relay/docs/design/2026-10-18-license-issuer-minimal.md` §3/§3.1/§3.2/§8
// ＋ `…/specs/2026-10-02-license-issuer-station-spec.md` §4/§7。
//
// ## 四条容易写错的（每条都有对应判据）
// ① **客户端不算、也不传价钱** —— 价钱由发卡站按配置算；请求体里出现 `price`/`amount*` 就是越界 ✗。
// ② 轮询与解绑走 `Authorization: Device {dev}:{ts}:{sig}`，`sig` 是**对被签名字节**签的（见 `signedBytes.ts`）。
// ③ `target` 参与签名时必须**含 query 整串**（解绑那条）。
// ④ **没配地址 ⇒ 整块关掉**：`isIssuerConfigured()` 为假时界面不许出现能点的"开通/续期"，
//    只写一句"没配发卡站地址"（⛔ 假按钮 ✗）。
import { nowTs, orderBytes, renewBytes, requestBytes, SHA256_EMPTY, unbindBytes } from "./signedBytes";

/** 发卡站配置（只有地址；⛔ 客户端不知道价钱，也不该知道）。 */
export interface IssuerConfig {
  /** 形如 `https://license.shuyo.cn`（末尾斜杠可省） */
  baseUrl: string;
}

/** 没配地址 ⇒ `false`（界面据此整块关掉，⛔ 不显示假按钮）。 */
export function isIssuerConfigured(baseUrl: string | null | undefined): boolean {
  const s = String(baseUrl ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** `Authorization: Device {dev}:{ts}:{sig}` 的头值（⚠️ 三格用 `:` 连，与规格一致）。 */
export function deviceAuthHeader(dev: string, ts: number, sigB64: string): string {
  return `Device ${dev}:${ts}:${sigB64}`;
}

/** 开通（下单）的请求体 —— ⚠️ **没有价钱**（⛔ 不许加 `price`/`amountCents` 之类）。 */
export interface CreateOrderInput {
  sub: string;
  days: number;
  dev: string;
  pubkey: string;
  seats?: number;
}

export function createOrderBody(input: CreateOrderInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sub: input.sub,
    days: input.days,
    dev: input.dev,
    pubkey: input.pubkey,
  };
  if (typeof input.seats === "number") body.seats = input.seats;
  return body;
}

/** 下单响应（服务端算好价钱与支付页）。 */
export interface CreateOrderResult {
  outTradeNo: string;
  amountCents: number;
  payUrl: string;
}

/** 轮询一条订单的路径（⚠️ 这条请求要签名，字节用 `orderBytes`）。 */
export function pollOrderPath(outTradeNo: string): string {
  return `/v1/orders/${encodeURIComponent(outTradeNo)}`;
}

/** 轮询结果：`paid` 时带卡。 */
export type OrderStatus = { status: "pending" } | { status: "paid"; card: string } | { status: "closed" };

/** 续期请求体（`sig` 是对 `renewBytes` 的签名）。 */
export interface RenewInput {
  card: string;
  dev: string;
  ts: number;
  sig: string;
}

export function renewBody(input: RenewInput): Record<string, unknown> {
  return { card: input.card, dev: input.dev, ts: input.ts, sig: input.sig };
}

/** 续期响应（新卡 + 本次的中继租约）。 */
export interface RenewResult {
  card: string;
  lease: string;
  jti: string;
  rot: number;
  exp: number;
  leaseJti: string;
  leaseExp: number;
}

/** 解绑请求体（⚠️ `target` 含 query 整串，且**它参与签名**）。 */
export interface UnbindInput {
  card: string;
  by: string;
  target: string;
  ts: number;
  sig: string;
}

export function unbindBody(input: UnbindInput): Record<string, unknown> {
  return { card: input.card, by: input.by, target: input.target, confirm: true, ts: input.ts, sig: input.sig };
}

/** 设备列表一条。 */
export interface DeviceRow {
  dev: string;
  addedAt: number;
  lastSeenAt?: number;
  current: boolean;
}

/** 一个最小的"签名器"接口：把被签名字节交出去，拿回 base64 的 Ed25519 签名。 */
export type Signer = (bytes: string) => Promise<string>;

/** 一个最小的 HTTP 接口（判据注入假实现 ⇒ 一次网都不出）。 */
export type Transport = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface IssuerDeps {
  baseUrl: string;
  signer: Signer;
  transport: Transport;
  now?: () => number;
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;

/** 带签名头的普通请求（`SHUYO-REQ-1` 字节）。 */
export function buildSignedRequestHeaders(args: {
  dev: string;
  ts: number;
  sig: string;
  method: string;
  target: string;
  bodyJson?: string;
}): Record<string, string> {
  const bodyHash = args.bodyJson === undefined ? SHA256_EMPTY : null;
  // ⚠️ `bodyHash` 只能由调用方算好传进来（本函数不引入哈希实现 —— 仓里已有 sha256 工具，
  //    在 `signedBytes` 之外的层注入，避免这里出现第二份实现）。
  const headers: Record<string, string> = {
    Authorization: deviceAuthHeader(args.dev, args.ts, args.sig),
    "content-type": "application/json",
  };
  if (bodyHash === null) headers["x-shuyo-signed"] = "sha256-body";
  return headers;
}

/** 开通：下单（⚠️ 请求体不含价钱）。 */
export async function createOrder(deps: IssuerDeps, input: CreateOrderInput): Promise<CreateOrderResult> {
  const ts = (deps.now ?? nowTs)();
  const bodyJson = JSON.stringify(createOrderBody(input));
  const target = "/v1/orders";
  const sig = await deps.signer(requestBytes("POST", target, ts, await sha256Hex(bodyJson)));
  const res = await deps.transport(join(deps.baseUrl, target), {
    method: "POST",
    headers: { Authorization: deviceAuthHeader(input.dev, ts, sig), "content-type": "application/json" },
    body: bodyJson,
  });
  if (res.status !== 200) throw new Error(`下单失败：HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as Partial<CreateOrderResult>;
  if (!json.outTradeNo || !json.payUrl || typeof json.amountCents !== "number") throw new Error("下单响应形状不认识");
  return { outTradeNo: json.outTradeNo, payUrl: json.payUrl, amountCents: json.amountCents };
}

/** 轮询订单（签名用**轮询单**字节）。 */
export async function pollOrder(deps: IssuerDeps & { dev: string }, outTradeNo: string): Promise<OrderStatus> {
  const ts = (deps.now ?? nowTs)();
  const sig = await deps.signer(orderBytes(outTradeNo, deps.dev, ts));
  const res = await deps.transport(join(deps.baseUrl, pollOrderPath(outTradeNo)), {
    method: "GET",
    headers: { Authorization: deviceAuthHeader(deps.dev, ts, sig) },
  });
  if (res.status !== 200) throw new Error(`查单失败：HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as { status?: string; card?: string };
  if (json.status === "paid" && typeof json.card === "string") return { status: "paid", card: json.card };
  if (json.status === "closed") return { status: "closed" };
  return { status: "pending" };
}

/** 续期：拿新卡 + 中继租约（⚠️ 租约只交给中继，⛔ 不写 profile）。 */
export async function renew(deps: IssuerDeps & { dev: string }, card: string): Promise<RenewResult> {
  const ts = (deps.now ?? nowTs)();
  const sig = await deps.signer(renewBytes(card, deps.dev, ts));
  const res = await deps.transport(join(deps.baseUrl, "/v1/renew"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(renewBody({ card, dev: deps.dev, ts, sig })),
  });
  if (res.status !== 200) throw new Error(`续期失败：HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as Partial<RenewResult>;
  if (!json.card || !json.lease) throw new Error("续期响应里没有新卡或租约");
  return json as RenewResult;
}

/** 设备列表（`GET /v1/devices?card={jti}`，签名用普通请求字节）。 */
export async function listDevices(deps: IssuerDeps & { dev: string; jti: string }): Promise<DeviceRow[]> {
  const ts = (deps.now ?? nowTs)();
  const target = `/v1/devices?card=${encodeURIComponent(deps.jti)}`;
  const sig = await deps.signer(requestBytes("GET", target, ts, SHA256_EMPTY));
  const res = await deps.transport(join(deps.baseUrl, target), {
    method: "GET",
    headers: { Authorization: deviceAuthHeader(deps.dev, ts, sig) },
  });
  if (res.status !== 200) throw new Error(`设备列表失败：HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as { devices?: DeviceRow[] };
  return Array.isArray(json.devices) ? json.devices : [];
}

/** 解绑一台设备（⚠️ `target` 含 query 整串，且参与签名）。 */
export async function unbindDevice(
  deps: IssuerDeps & { dev: string },
  input: { card: string; by: string; target: string },
): Promise<void> {
  const ts = (deps.now ?? nowTs)();
  const sig = await deps.signer(unbindBytes(input.card, input.by, input.target, ts));
  const res = await deps.transport(join(deps.baseUrl, "/v1/devices/unbind"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unbindBody({ ...input, ts, sig })),
  });
  if (res.status !== 200) throw new Error(`解绑失败：HTTP ${res.status}`);
}

/** sha256 的十六进制 —— 由注入的实现提供（⛔ 本文件不自己 `createHash`）。 */
let hashImpl: ((s: string) => Promise<string>) | null = null;

/** 装配期注入（浏览器用 WebCrypto、Node 用 `node:crypto`；判据注入固定值）。 */
export function setSha256Hex(fn: (s: string) => Promise<string>): void {
  hashImpl = fn;
}

async function sha256Hex(s: string): Promise<string> {
  if (!hashImpl) {
    // 没注入 ⇒ 用 WebCrypto（浏览器/Node ≥ 18 都有）；空串直接给常量，省一次 IPC
    if (!s) return SHA256_EMPTY;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return hashImpl(s);
}
