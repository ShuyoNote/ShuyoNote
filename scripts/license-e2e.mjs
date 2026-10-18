#!/usr/bin/env node
// **真链路验收**：本机发卡站 → 真卡 → 我们的解析/五态 → 真续期（rot+1）。
//
// ⚠️ 它**不是**默认门禁（要一台在跑的发卡站 ≠ 任何机器都有）⇒ 故意不注册进 `scripts/lib/gates.mjs`，
//    也不进 `pnpm verify`。缺站时它 **exit 2（环境不具备，不算通过）**，与工作区那条口径一致。
//
// ## 用法
//   1) 起站（另一进程，默认 127.0.0.1:8789）：见 `repos/shuyonote-relay/docs/design/2026-10-18-license-issuer-minimal.md` §8
//   2) `ISSUER_ADMIN_TOKEN=<令牌> node scripts/license-e2e.mjs`
//      · `ISSUER_BASE`（默认 http://127.0.0.1:8789）
//      · `ISSUER_ADMIN_TOKEN`（管理面发卡必需；缺 ⇒ exit 2）
//
// ## 它为什么不是"另写一份客户端"
// 下面 `stageModules()` 把 `src/lib/license/{signedBytes,card,issuer}.ts` **原样复制**到临时目录，
// 只给相对 import 补 `.ts` 后缀（Node 的 ESM 需要）；并打印"去掉 import 行后的正文哈希"，
// 证明复制件与原文**是同一份逻辑**（⛔ 不是在这里重写一套布局 ✗）。
import { createHash } from "node:crypto";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");
const SRC = join(REPO, "src/lib/license");
const STAGE = join(REPO, "_tmp/license-e2e-lib");

const BASE = (process.env.ISSUER_BASE ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const ADMIN = process.env.ISSUER_ADMIN_TOKEN ?? "";

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

if (!ADMIN) {
  console.error("[license-e2e] 缺 ISSUER_ADMIN_TOKEN ⇒ 环境不具备（exit 2，**不算通过**）");
  process.exit(2);
}

/** 复制模块（只补 import 后缀），并核"正文哈希相同"。 */
function stageModules() {
  mkdirSync(STAGE, { recursive: true });
  const body = (t) => t.replace(/^import .*$/gm, "").replace(/\r\n/g, "\n");
  const h = (t) => createHash("sha256").update(body(t)).digest("hex").slice(0, 12);
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(SRC, f), "utf8");
    const out = text.replace(/from "\.\/([a-zA-Z]+)"/g, 'from "./$1.ts"');
    writeFileSync(join(STAGE, f), out, "utf8");
    if (!body(text).includes("import ")) {
      // 只对"会被 Node 直接 import 的那三个"核一遍
      if (["signedBytes.ts", "types.ts", "card.ts", "issuer.ts"].includes(f) && h(text) !== h(out)) {
        throw new Error(`复制件与原文不一致：${f}`);
      }
    }
  }
}

stageModules();
const lib = pathToFileURL(STAGE).href;
const { renewBytes } = await import(`${lib}/signedBytes.ts`);
const { parseCard, cardState, daysLeft, pickCurrent } = await import(`${lib}/card.ts`);
const { renew, listDevices } = await import(`${lib}/issuer.ts`);

// ── 设备身份（与 Rust `device_identity.rs` 同一条规则：dev = dev-<sha256(pubkey)[..8]>）──
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pubRaw = publicKey.export({ format: "der", type: "spki" }).slice(-32);
const dev = "dev-" + createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);
const pubB64 = pubRaw.toString("base64url");
const signer = async (bytes) => edSign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url");
const transport = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, text: () => r.text() };
};

console.log(`[license-e2e] 发卡站 ${BASE} ｜ 设备 ${dev}`);

const issueRes = await fetch(`${BASE}/v1/admin/cards`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Admin-Token": ADMIN },
  body: JSON.stringify({ sub: `sub-e2e-${Date.now().toString(36)}`, days: 30, devices: [{ dev, pubkey: pubB64 }] }),
});
ok(issueRes.status === 200, `管理面发卡 HTTP 200（实际 ${issueRes.status}）`);
let issued = {};
try {
  issued = await issueRes.json();
} catch {
  /* 下面报 */
}
ok(typeof issued.card === "string" && issued.card.startsWith("SHUYO-LIC-1."), "拿到的是真卡文本");

const parsed = parseCard(issued.card ?? "");
ok(parsed.ok, `我们的解析器读得出来（${parsed.ok ? "ok" : parsed.error}）`);
if (!parsed.ok) {
  console.log(`\n[结果] ${pass} 通过 / ${fail + 1} 失败`);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
ok(cardState(parsed.payload, now) === "active", "五态 = active");
const days = daysLeft(parsed.payload, now);
ok(days >= 29 && days <= 31, `剩余天数是真的（${days} 天，期望 ≈30，且**不含宽限**）`);
ok(parsed.payload.dev.includes(dev), "卡里登记的设备就是本机这个 dev");
ok(parsed.payload.cap.includes("crossnet"), "cap 含 crossnet（停卡那张会是空）");

try {
  const rows = await listDevices({ baseUrl: BASE, dev, jti: parsed.payload.jti, signer, transport, now: () => now });
  ok(Array.isArray(rows) && rows.length >= 1, `设备列表读得到（${rows.length} 台）`);
} catch (e) {
  ok(false, `设备列表失败：${e instanceof Error ? e.message : String(e)}`);
}

try {
  ok(typeof renewBytes === "function", "被签名字节来自客户端模块本身");
  const out = await renew({ baseUrl: BASE, dev, signer, transport, now: () => now }, issued.card);
  ok(out.rot === parsed.payload.rot + 1, `rot 换代 +1（${parsed.payload.rot} → ${out.rot}）`);
  ok(typeof out.lease === "string" && out.lease.length > 10, "续期同时给了中继租约");
  const np = parseCard(out.card);
  ok(np.ok, "新卡也解析得出来");
  if (np.ok) {
    ok(!!np.payload.prev, "新卡带 prev（前一代 jti 的散列）");
    ok(np.payload.jti !== parsed.payload.jti, "jti 换了（新的一张，⛔ 不是复用）");
    ok(
      np.payload.exp >= parsed.payload.exp,
      `exp 没有缩短（${parsed.payload.exp} → ${np.payload.exp}；⚠️ 免费轮换不延长，延长要付过款）`,
    );
    const picked = pickCurrent([
      { payload: parsed.payload, tag: "old" },
      { payload: np.payload, tag: "new" },
    ]);
    ok(picked?.tag === "new", "按 rot 挑当前代 ⇒ 挑中新卡");
  }
} catch (e) {
  ok(false, `续期失败：${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
