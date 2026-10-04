#!/usr/bin/env node
// check-pairing-requires-proof.mjs —— 「配对**必须有人核对过**」判据（纯读源码 ⇒ **不需要 cargo** ✓）
//
// 规格：`docs/specs/2026-09-29-personal-edition-spec.md` 的两条 ——
//   `INV-PER-pairing-requires-proof`（⚠️ 半有）／`INV-PER-pairing-needs-no-acceptance`（❌ 无（要立））
//   ＋ 判据矩阵 `U2`（反向：**不许有"自动通过"**）／`U3`（两端码不一致 ⇒ 停）／`U4`（**码长不许缩短**）
//
// 挡的是哪一类真实事故（incident）：
//   配对码是**唯一**的防"换码"手段 —— 攻击者把载荷换成自己那份、再让用户扫，
//   用户的空间就同步进了**攻击者知道钥匙**的地方 ✗。而这类坏法**全都是"减法"**：
//   把"必须核对"改成"可选"、把码长缩短、给"停"态加一个"继续"按钮 ——
//   ⭐ 功能全对、测试全绿（因为**没有人会为"少了一次核对"写测试**），只有用户那边出事 ✓。
//
// 判据五条（**都是真断言，且今天全绿** ✓）：
//   ① **码长下限没被缩短**：`CHECK_CODE_MIN_BITS` 的值 ≥ 60（矩阵 U4）
//   ② **比对码真的比**：`verify_confirm_code` 里必须有"算出来的 ≠ 用户记下的 ⇒ Err"这条形状
//   ③ **采纳之前必须先过比对码**：`pairing_import` 里 `verify_confirm_code(` 出现在 `adopt_material(` **之前**
//   ④ **拒绝路不许继续采纳**：从 `verify_confirm_code(` 到 `adopt_material(` 之间必须出现 `"rejected"`
//   ⑤ **配对路径上不许有"等对端同意"的状态**（`INV-PER-pairing-needs-no-acceptance`）
//
// ⚠️ **登记形态**：设备直连那半（`device_pair_export`／`device_pair_import`）**今天还没落地** ✗
//   ⇒ 那半边**自报跳过（不装绿）**；`--require-device-pair` ⇒ exit 2（＝"要看那次红"的口子 ✓）。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 被显式要求的东西不在（**不算通过**）
// 用法：node scripts/check-pairing-requires-proof.mjs ／ --root <仓根> ／ --require-device-pair ／ --self-test

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

/** 码长下限的**设计下限**（设计稿 §3 / 矩阵 U4 逐字：不许低于 60 bit） */
const MIN_BITS_FLOOR = 60;

/** ⛔ 配对路径上**不许出现**的"等对端同意"一类标识（§INV-PER-pairing-needs-no-acceptance） */
const FORBIDDEN_ACCEPTANCE = [
  "pending_accept", "awaiting_peer", "waiting_for_accept", "accept_pending",
  "peer_must_confirm", "needs_peer_approval", "peer_approved",
];

/** 取一个 Rust 函数的体（从签名的第一个 `{` 起 —— 别把形参名算进去 ✗，见 check-im-boundary 的同一条教训） */
function bodyOf(text, sigRe) {
  const m = text.match(sigRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const brace = after.indexOf("{");
  if (brace < 0) return null;
  const body = after.slice(brace + 1);
  const end = body.search(/\n\}\n/);
  return end < 0 ? body : body.slice(0, end);
}

/** 纯判据：源码文本 ⇒ findings（空＝干净 ✓） */
export function judge({ pairingRs, syncRs }) {
  const out = [];

  // ① 码长下限没被缩短
  const mBits = pairingRs.match(/CHECK_CODE_MIN_BITS\s*:\s*u32\s*=\s*(\d+)/);
  if (!mBits) out.push("✗ 解析不到 `CHECK_CODE_MIN_BITS: u32 = <数字>` ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else if (Number(mBits[1]) < MIN_BITS_FLOOR) {
    out.push("✗ `CHECK_CODE_MIN_BITS` = " + mBits[1] + " ⇒ **低于设计下限 " + MIN_BITS_FLOOR +
      " bit** ✗（矩阵 U4：码长**不许缩短** ✓）");
  }

  // ② 比对码真的比
  const vbody = bodyOf(pairingRs, /pub\s+fn\s+verify_confirm_code\s*\(/);
  if (vbody === null) out.push("✗ 找不到 `pairing::verify_confirm_code` ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else {
    if (!/!=\s*digits_only\(/u.test(vbody) && !/digits_only\([^)]*\)\s*!=/.test(vbody)) {
      out.push("✗ `verify_confirm_code` 里没有「算出来的 ≠ 用户记下的」这条比较 ⇒ **核对退化了** ✗（那就等于没有核对 ✓）");
    }
    if (!/return\s+Err\(/.test(vbody)) {
      out.push("✗ `verify_confirm_code` 里没有 `return Err(` ⇒ **对不上也放行** ✗（矩阵 U2 的反向：不许有\"自动通过\" ✓）");
    }
  }

  // ③④ 采纳之前必须先过比对码 ＋ 拒绝路不许继续采纳
  const ibody = bodyOf(syncRs, /pub\s+fn\s+pairing_import\s*\(/);
  if (ibody === null) out.push("✗ 找不到 `sync::pairing_import` ⇒ 判据**没检查到东西**（不算通过 ✗）");
  else {
    const iVerify = ibody.indexOf("verify_confirm_code(");
    const iAdopt = ibody.indexOf("adopt_material(");
    if (iVerify < 0) out.push("✗ `pairing_import` 里没调 `verify_confirm_code(` ⇒ **采纳之前没有核对那一步** ✗");
    else if (iAdopt < 0) out.push("✗ `pairing_import` 里没调 `adopt_material(` ⇒ 判据没检查到东西（不算通过 ✗）");
    else if (iVerify > iAdopt) out.push("✗ `pairing_import` 里 `adopt_material(` **出现在** `verify_confirm_code(` **之前** ⇒ **先采纳、后核对** ✗");
    else {
      const between = ibody.slice(iVerify, iAdopt);
      if (!between.includes('"rejected"')) {
        out.push("✗ 比对码那条 `Err` 路上没有 `\"rejected\"` ⇒ **对不上却继续往下采纳** ✗（矩阵 U3：两端码不一致 ⇒ **停** ✓）");
      }
    }
  }

  // ⑤ 配对路径上不许有"等对端同意"的状态
  const hay = [
    { name: "pairing.rs", text: pairingRs },
    { name: "sync.rs", text: syncRs },
  ];
  for (const { name, text } of hay) {
    for (const bad of FORBIDDEN_ACCEPTANCE) {
      if (text.includes(bad)) {
        out.push("✗ `" + name + "` 里出现了 `" + bad + "` ⇒ 配对路径上多了「**等对端同意**」这一步 ✗" +
          "（`INV-PER-pairing-needs-no-acceptance`：配对**不需要**对方再点一次同意 ✓）");
      }
    }
  }

  return out;
}

function run(root, requireDevicePair) {
  const src = join(root, "src-tauri", "src");
  if (!existsSync(src)) { console.error("✗ 源码树不在：" + src + "（**不算通过**）"); return 2; }
  const pairingPath = join(src, "pairing.rs"), syncPath = join(src, "sync.rs");
  if (!existsSync(pairingPath) || !existsSync(syncPath)) {
    console.error("✗ 读不到 `src-tauri/src/pairing.rs` 或 `sync.rs`（**不算通过**）"); return 2;
  }
  const pairingRs = readFileSync(pairingPath, "utf8");
  const syncRs = readFileSync(syncPath, "utf8");

  const findings = judge({ pairingRs, syncRs });
  if (findings.length) { for (const x of findings) console.error(x); return 1; }

  // 设备直连那半：今天没有 ⇒ 自报跳过（不装绿 ✓）
  const hasDevicePair = /device_pair_export|device_pair_import/.test(syncRs);
  if (!hasDevicePair) {
    if (requireDevicePair) {
      console.error("  ⇒ 已给 `--require-device-pair` ⇒ 按「设备直连配对还没落地 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ! 自报跳过（不装绿）：设备直连那半（`device_pair_export`／`device_pair_import`）**还没落地** ⇒ " +
      "「**设备直连配对必须有人的那一步、且没有\"自动通过\"**」这一条现在没有可检查对象（要看那次红就加 `--require-device-pair` ✓）");
  }

  console.log("✓ 配对必须有人核对：码长下限 " + MIN_BITS_FLOOR + " bit 未被缩短 ✓ ｜ 比对码真的比（不等 ⇒ Err）✓ ｜ " +
    "采纳之前先过比对码 ✓ ｜ 拒绝路不继续采纳 ✓ ｜ 配对路径上没有\"等对端同意\"的状态 ✓");
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const pairingGood = [
    "pub const CHECK_CODE_MIN_BITS: u32 = 60;",
    "pub fn verify_confirm_code(payload_text: &str, confirmed: Option<&str>) -> Result<String, String> {",
    "    let computed = check_code(payload_text);",
    "    let Some(user) = confirmed else {",
    "        return Ok(computed);",
    "    };",
    "    if digits_only(&computed) != digits_only(user) {",
    "        return Err(format!(\"比对码对不上 ⇒ 没有采纳，本机一个字节都没改\"));",
    "    }",
    "    Ok(computed)",
    "}",
  ].join("\n");
  const syncGood = [
    "pub fn pairing_import(db: State<'_, Db>, args: PairingImportArgs) -> Result<PairingImportResult, String> {",
    "    let check_code = match crate::pairing::verify_confirm_code(&args.text, args.confirmed_check_code.as_deref()) {",
    "        Ok(code) => code,",
    "        Err(e) => {",
    "            return Ok(PairingImportResult { outcome: \"rejected\".to_string(), message: e });",
    "        }",
    "    };",
    "    let report = crate::space_crypto::adopt_material(&c, &payload.material, args.overwrite)?;",
    "    Ok(PairingImportResult { outcome: \"ok\".to_string() })",
    "}",
  ].join("\n");
  const good = { pairingRs: pairingGood, syncRs: syncGood };
  // 显式夹具：**先采纳、后核对**（不用字符串手术 —— 手术版自测当场造出了另一条 finding ✓）
  const syncAdoptFirst = [
    "pub fn pairing_import(db: State<'_, Db>, args: PairingImportArgs) -> Result<PairingImportResult, String> {",
    "    let report = crate::space_crypto::adopt_material(&c, &payload.material, args.overwrite)?;",
    "    let check_code = crate::pairing::verify_confirm_code(&args.text, args.confirmed_check_code.as_deref());",
    "    Ok(PairingImportResult { outcome: \"ok\".to_string(), message: format!(\"{report:?} {check_code:?}\") })",
    "}",
  ].join("\n");
  const cases = [
    ["合规 ⇒ 空", judge(good).length === 0],
    ["码长缩到 40 ⇒ 红", judge({ ...good, pairingRs: good.pairingRs.replace("= 60;", "= 40;") }).some((s) => s.includes("低于设计下限"))],
    ["比对退化成不比较 ⇒ 红", judge({ ...good, pairingRs: good.pairingRs.replace("if digits_only(&computed) != digits_only(user) {", "if false {") }).some((s) => s.includes("核对退化"))],
    ["对不上也放行（没有 Err）⇒ 红", judge({ ...good, pairingRs: good.pairingRs.replace('return Err(format!("比对码对不上 ⇒ 没有采纳，本机一个字节都没改"));', "") }).some((s) => s.includes("对不上也放行"))],
    ["先采纳后核对 ⇒ 红", judge({ ...good, syncRs: syncAdoptFirst }).some((s) => s.includes("先采纳、后核对"))],
    ["拒绝路继续采纳（没有 rejected）⇒ 红", judge({ ...good, syncRs: syncGood.replace('outcome: "rejected".to_string(), ', 'outcome: "ok".to_string(), ') }).some((s) => s.includes("继续往下采纳"))],
    ["配对路径加了「等对端同意」⇒ 红", judge({ ...good, pairingRs: good.pairingRs + "\npub struct PendingAccept { pub awaiting_peer: bool }\n" }).some((s) => s.includes("等对端同意"))],
    ["源码缺 `pairing.rs` 的常量 ⇒ 红（不许假绿）", judge({ ...good, pairingRs: "// 什么都没有\n" }).some((s) => s.includes("没检查到东西"))],
  ];
  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  console.log("self-test: " + pass + "/" + cases.length + " 通过");
  process.exit(pass === cases.length ? 0 : 1);
}

const ri = argv.indexOf("--root");
process.exit(run(ri >= 0 ? argv[ri + 1] : ROOT, argv.includes("--require-device-pair")));
