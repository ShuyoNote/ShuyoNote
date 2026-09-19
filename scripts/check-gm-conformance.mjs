// 国密对拍夹具的**跨平台驱动**（权威入口；`tools/gm-conformance/driver-linux.sh` 只是来源凭证）。
//
// 为什么要有这条门禁（`gates.mjs` 里也写了 incident）：国密这条线**同时保两份 SM4 实现** ——
// 应用层走 RustCrypto（纯 Rust，全平台同一份）、库级走 Tongsuo（C，SQLCipher 的 provider）。
// 两份实现**漂移**的后果是「跨设备读不出对方的数据」（密文互解失败），而它**没有任何编译期信号**，
// 也不会在本机单测里露头 ⇒ 只能靠一条对着**标准向量 + 对方实现**的对拍判据守着。
//
// 夹具来源：AMD 2026-09-17 在信箱仓写的 `gm-conformance`（Linux 侧 5 个用例）。搬迁时做了三件事：
//   ① **不带 `target/`**（原仓把 26M 构建产物commit了）；
//   ② 驱动**重写成跨平台 Node**（原 `driver.sh` 用 `stat -c` / `sha256sum` / `$HOME/tongsuo-build`
//      这类 Linux 专用假设，在 macOS/Windows 上跑不了）；
//   ③ Tongsuo 缺席时**自报跳过**（`! …跳过…` 行，会被 `report-core.mjs` 收成一等公民），
//      绝不静默通过 —— 这一路反复吃过"失败得像成功"的亏。
//
// 用例（前三个**任何机器**都能跑；后三个需要 Tongsuo）：
//   R1 GM/T 0002 SM4-ECB 标准向量（夹具自己算并自比）
//   R2 GM/T 0004 SM3("abc") 标准向量
//   R3 SM4-CBC + PKCS#7 往返（37 字节非整块明文 ⇒ 必然补到 48，专测填充）
//   R4 HMAC-SM3：32 字节 tag + 确定性（同输入两次同值）
//   T1 Tongsuo 自己命中同样的标准向量
//   T2/T3 双向互解：RustCrypto 加密 → Tongsuo 解密；Tongsuo 加密 → RustCrypto 解密
//   T4 两侧密文**逐字节相同**（CBC+PKCS#7 下应当如此）+ HMAC-SM3 两侧一致
//   T5 PBKDF2-HMAC-SM3 跨实现（2026-09-19 加入）：同口令/同盐/20 万轮/输出 64 字节逐字节相同；
//      并钉住"**SM4 取前 16 字节**、**MAC 取后 32 字节**"这两条口径（取错就是跨设备互相解不开，
//      而它没有任何编译期信号、本机单测也照绿 —— 这正是这条线最该防的漂移）
//
// 用法：node scripts/check-gm-conformance.mjs
//   需要 Tongsuo 的那几条：设 `SHUYONOTE_TONGSUO_OPENSSL=/path/to/openssl`（Tongsuo 的 CLI）。
//   **只看这一个环境变量**（刻意不探测 PATH，理由见下面那一节）：没设 ⇒ 那几条自报跳过、本条门禁仍绿；
//   **设了但用不了 ⇒ 红**（那是"这一路判据失效"，不是"跳过"）。
//   macOS 上编 Tongsuo：`./Configure --prefix=<p> no-tests && make -j && make install_sw`
//   ⇒ 装到 `<p>/lib`（Linux 是 `lib64/`，别照抄；实测 commit 540603a3 / 底层 OpenSSL 3.5.4）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(root, "tools", "gm-conformance");
const binPath = join(crateDir, "target", "release", "gm-conformance");

// GM/T 0002 / GM/T 0004 的标准向量（夹具内部也硬编码同一组；这里再写一遍是**故意的** ——
// 判据与实现不共用同一份常量，否则"改了实现里那个常量"会让两边一起错还不报警）。
const KEY = "0123456789abcdeffedcba9876543210";
const IV = "000102030405060708090a0b0c0d0e0f";
const EXP_ECB = "681edf34d206965e86b3e94f536e4246";
const EXP_SM3_ABC = "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0";

const problems = [];
const skips = [];
let ran = 0;
// 「空跑即红」的下限**随 Tongsuo 是否参与而变**（不是拍一个固定数）：
//   · Tongsuo 缺席 ⇒ 3 个用例（R1/R2 标准向量合并算 1、R3 往返、R4 HMAC）
//   · Tongsuo 在场 ⇒ 12 个用例（R 三个 ＋ T1 两条标准向量 ＋ T2/T3 双向互解各一 ＋ T4 密文一致/HMAC 一致
//     ＋ T5 的 KDF 一致 / SM4 取前 16 / MAC 取后 32 三条）
// 固定下限的坏处：设 3 时"Tongsuo 分支整段被删掉"也照样绿；设 12 时无 Tongsuo 的机器永远红。
// ⚠️ 这个数**按上面 `ran++` 的条数逐条数出来的**（不是估的）：R 3 ＋ T1 2 ＋ T2 1 ＋ T3 1 ＋ T4 2 ＋ T5 3 = 12。
let minCases = 3;

const fail = (msg) => problems.push(msg);
const hex = (buf) => Buffer.from(buf).toString("hex");

/** 跑夹具 CLI。`input` 给 stdin（`sm3 -` 用）。 */
function gm(args, { input, allowFail = false } = {}) {
  try {
    return execFileSync(binPath, args, { input, encoding: "utf8", maxBuffer: 8 << 20 }).trim();
  } catch (e) {
    if (allowFail) return null;
    fail(`夹具命令失败：gm-conformance ${args.join(" ")} ⇒ ${String(e.message).split("\n")[0]}`);
    return null;
  }
}

/** 跑 openssl（Tongsuo 的 CLI）。 */
function ossl(openssl, args, { input } = {}) {
  try {
    return execFileSync(openssl, args, { input, encoding: "buffer", maxBuffer: 8 << 20 });
  } catch (e) {
    fail(`openssl 命令失败：${openssl} ${args.join(" ")} ⇒ ${String(e.message).split("\n")[0]}`);
    return null;
  }
}

// ---- 0. 构建（缺失或源码更新才编；`cargo build` 自己判断）----
try {
  execFileSync("cargo", ["build", "--release", "--manifest-path", join(crateDir, "Cargo.toml")], {
    cwd: crateDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  console.error("gm-conformance: ❌ 夹具编不过");
  console.error(String(e.stderr ?? e.message).slice(0, 2000));
  process.exit(1);
}
if (!existsSync(binPath)) {
  // ★ "空跑像没事" 的防线：编完了却找不到二进制 ⇒ 红，不是跳过
  console.error(`gm-conformance: ❌ 构建后找不到夹具二进制 ${binPath}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "gm-conf-"));
try {
  // ---- R1/R2：标准向量（夹具自算自比）----
  const vec = gm(["vectors"]);
  if (vec === null) {
    fail("夹具 `vectors` 没有输出");
  } else {
    ran++;
    for (const [key, want] of [
      ["sm4-ok", "true"],
      ["sm3-ok", "true"],
    ]) {
      const m = new RegExp(`^${key}\\s*=\\s*(\\S+)\\s*$`, "m").exec(vec);
      if (!m) fail(`夹具 \`vectors\` 输出里没有 ${key} 一行（夹具被改过？输出：${vec.replace(/\n/g, " | ")}）`);
      else if (m[1] !== want) fail(`标准向量未命中：${key}=${m[1]}（期望 ${want}）`);
    }
    // 夹具自报的十六进制值也要与**判据侧**这份常量一致（两边独立硬编码 ⇒ 对不上一方有错）
    const ecb = /^sm4-ecb\s*=\s*(\S+)\s*$/m.exec(vec)?.[1];
    const sm3 = /^sm3\s*=\s*(\S+)\s*$/m.exec(vec)?.[1];
    if (ecb !== EXP_ECB) fail(`SM4-ECB 标准向量：夹具 ${ecb} vs 判据 ${EXP_ECB}`);
    if (sm3 !== EXP_SM3_ABC) fail(`SM3("abc") 标准向量：夹具 ${sm3} vs 判据 ${EXP_SM3_ABC}`);
  }

  // ---- R3：SM4-CBC + PKCS#7 往返（37 字节 ⇒ 补到 48）----
  // 37 字节：**非** 16 的整数倍 ⇒ PKCS#7 会**补一整块**到 48（专测填充口径）。
  // ⚠️ 第一版把明文写成 39 字节（字面串数错了），下面那条自检当场判红 —— 这条自检就是为了这个：
  // "判据自己的前提被破坏"必须比"用例通过"更早暴露。
  // ⚠️ 长度**程序化构造**，不靠我数字面串（第一版我两次数错：39、34 —— 都被下面的自检抓到）：
  const PT_PREFIX = "ShuyoNote-GM-conformance-case3-";
  const pt = Buffer.alloc(37, 0x2e /* '.' */);
  Buffer.from(PT_PREFIX, "utf8").copy(pt);
  if (pt.length !== 37) fail(`判据自己的明文不是 37 字节（${pt.length}）—— 这条用例的前提被破坏了`);
  const ptFile = join(tmp, "pt.bin");
  writeFileSync(ptFile, pt);
  const ctHex = gm(["enc", KEY, IV, ptFile]);
  if (ctHex === null) {
    fail("SM4-CBC 加密没有输出");
  } else {
    ran++;
    const ct = Buffer.from(ctHex, "hex");
    if (ct.length !== 48) fail(`PKCS#7 填充后应为 48 字节，实际 ${ct.length}`);
    const ctFile = join(tmp, "ct.hex");
    writeFileSync(ctFile, ctHex);
    const back = gm(["dec", KEY, IV, ctFile]);
    if (back === null) {
      fail("SM4-CBC 解密没有输出");
    } else if (back !== pt.toString("utf8")) {
      fail("SM4-CBC 往返明文不一致（CBC/PKCS#7 口径被改坏？）");
    }
  }

  // ---- R4：HMAC-SM3（32 字节 tag + 确定性）----
  const macFile = join(tmp, "mac.bin");
  writeFileSync(macFile, Buffer.from("mac-input-for-gm-conformance", "utf8"));
  const mac1 = gm(["hmac", KEY, macFile]);
  const mac2 = gm(["hmac", KEY, macFile]);
  if (mac1 === null || mac2 === null) {
    fail("HMAC-SM3 没有输出");
  } else {
    ran++;
    if (mac1.length !== 64) fail(`HMAC-SM3 tag 应为 32 字节（64 个十六进制字符），实际 ${mac1.length} 字符`);
    if (mac1 !== mac2) fail("HMAC-SM3 同输入两次结果不同（实现里有非确定因素？）");
  }

  // ---- Tongsuo（可选，**必须显式给路径**）----
  //
  // ⚠️ 为什么**不**自动探测 PATH 上的 `openssl`（2026-09-19 被 CI 教育的）：
  //   ① 判据的意图是"跟**随包发的那份 Tongsuo** 对拍" —— 它是应用库级真正用的 provider；
  //   ② 自动探测会让**同一条门禁在不同平台的语义不同**：macOS 的 LibreSSL 探不到（跳过），
  //      而 Ubuntu 的 OpenSSL 3 **自带 SM4** ⇒ 那一支会自动打开，于是"本机绿"与"CI 红"分叉，
  //      而且红的原因与代码无关（第三份实现介入了对拍）。这正是这一路最忌讳的"门禁自己制造惊喜"。
  //   ③ 系统 OpenSSL 是**第三份** SM4 实现；拿它当"另一方"会把判据的名字变成假话。
  // ⇒ 只认 `SHUYONOTE_TONGSUO_OPENSSL`（显式、可复核、与"装了 Tongsuo 的机器"一一对应）。
  const openssl = process.env.SHUYONOTE_TONGSUO_OPENSSL || null;
  const tongsuo = openssl ? probeSm4Cbc(openssl) : { ok: false, why: "未设置 SHUYONOTE_TONGSUO_OPENSSL" };
  if (!tongsuo.ok && openssl) {
    // ★ **指名了却用不了 = 红，不是跳过**（2026-09-19 macOS 侧补；与 AMD 同轮各自发现探针 bug，
    //   这一段是合并时保留的那一半）：两件事后果完全不同 —— 没给路径是"这台机器没装 Tongsuo"
    //   （合法跳过）；给了路径却打不开是"这一路判据根本没跑"，而它伪装成跳过时，人会以为"对拍有了"。
    //   上面那个 8 字节探针 bug 正是这么瞒过好几轮的。
    fail(
      `指名了 Tongsuo（${openssl}）但它不可用：${tongsuo.why}` +
        ` —— 这不是"跳过"，是跨实现对拍这一路判据失效（探针喂的明文必须是**一个分组**，见 probeSm4Cbc 注释）`,
    );
  }
  if (!tongsuo.ok && !openssl) {
    skips.push(
      `跨实现对拍 9 项跳过（T1 标准向量 2 ＋ T2/T3 双向互解 2 ＋ T4 密文一致/HMAC 一致 2 ＋ T5 KDF 口径 3）：` +
        `未提供 Tongsuo —— 设 SHUYONOTE_TONGSUO_OPENSSL=<Tongsuo>/bin/openssl 后重跑` +
        `（R1–R4 已覆盖"实现没被改坏"；本门禁**刻意不**自动用系统 openssl，理由见脚本里那一节注释）`,
    );
  }
  if (tongsuo.ok) {
    minCases = 12;
    // 先把"另一方是谁"记下来：探针只能证明"它算得出 SM4"，证不出它是 Tongsuo
    // （2026-09-19 macOS 侧实测：系统自带的 LibreSSL `/usr/bin/openssl` 也能把整段 T 全过 ——
    //  它也有 SM4）⇒ 名字与事实靠不住，所以把版本行打出来让读数可复核。
    try {
      const ver = execFileSync(openssl, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      console.log(`  对拍另一方：${String(ver).trim().replace(/\n/g, " / ")}　（${openssl}）`);
    } catch {
      /* 版本行读不到不影响判据本身（真正的失败会在下面各条 T 用例里炸出来） */
    }
    // T1：Tongsuo 自己命中同样的标准向量
    const vecFile = join(tmp, "vec.bin");
    writeFileSync(vecFile, Buffer.from(KEY, "hex"));
    const tEcb = ossl(openssl, ["enc", "-sm4-ecb", "-K", KEY, "-nopad", "-in", vecFile]);
    ran++;
    if (tEcb === null || hex(tEcb) !== EXP_ECB) fail(`Tongsuo SM4-ECB 未命中标准向量：${tEcb ? hex(tEcb) : "(无输出)"}`);
    const abcFile = join(tmp, "abc.bin");
    writeFileSync(abcFile, Buffer.from("abc", "utf8"));
    const tSm3 = ossl(openssl, ["dgst", "-sm3", abcFile]);
    ran++;
    const tSm3Hex = tSm3 ? String(tSm3).trim().split(/\s+/).pop() : null;
    if (tSm3Hex !== EXP_SM3_ABC) fail(`Tongsuo SM3("abc") 未命中标准向量：${tSm3Hex}`);

    // T2：RustCrypto 加密 → Tongsuo 解密
    const ctHexR = gm(["enc", KEY, IV, ptFile]);
    const ctFileR = join(tmp, "ct_rust.bin");
    if (ctHexR !== null) writeFileSync(ctFileR, Buffer.from(ctHexR, "hex"));
    ran++;
    const backTon = ctHexR === null ? null : ossl(openssl, ["enc", "-d", "-sm4-cbc", "-K", KEY, "-iv", IV, "-in", ctFileR]);
    if (backTon === null || hex(backTon) !== hex(pt)) fail("Tongsuo 解不开/解错 RustCrypto 的密文");

    // T3：Tongsuo 加密 → RustCrypto 解密
    const ctTon = ossl(openssl, ["enc", "-sm4-cbc", "-K", KEY, "-iv", IV, "-in", ptFile]);
    const ctTonHexFile = join(tmp, "ct_ton.hex");
    if (ctTon !== null) writeFileSync(ctTonHexFile, hex(ctTon));
    ran++;
    const backRust = ctTon === null ? null : gm(["dec", KEY, IV, ctTonHexFile], { allowFail: true });
    if (backRust !== pt.toString("utf8")) fail("RustCrypto 解不开/解错 Tongsuo 的密文");

    // T4：两侧密文逐字节相同 + HMAC-SM3 两侧一致
    ran++;
    if (ctTon !== null && ctHexR !== null && hex(ctTon) !== ctHexR) {
      fail(`两侧密文不同：Tongsuo ${hex(ctTon).slice(0, 32)}… vs RustCrypto ${ctHexR.slice(0, 32)}…`);
    }
    const macRust = gm(["hmac", KEY, macFile]);
    const macTon = ossl(openssl, ["dgst", "-sm3", "-mac", "HMAC", "-macopt", `hexkey:${KEY}`, macFile]);
    ran++;
    const macTonHex = macTon ? String(macTon).trim().split(/\s+/).pop() : null;
    if (!macRust || macRust !== macTonHex) fail(`HMAC-SM3 两侧不一致：RustCrypto ${macRust} vs Tongsuo ${macTonHex}`);

    // ---- T5：PBKDF2-HMAC-SM3 跨实现 + 两条拆key口径（2026-09-19 加入，macOS 侧提出）----
    //
    // 参数是**对方信里钉死的那一组**（同口令 / 同 16 字节盐 / 20 万轮 / 输出 64 字节），
    // 所以这条用例同时也是"口径 1"的取证：两侧的 KDF 输出必须逐字节相同。
    const T5_PASS = "a-typical-passphrase";
    const T5_SALT = "5a".repeat(16);
    const T5_ITERS = 200_000;
    const T5_LEN = 64;
    const kdfRust = gm(["kdf", T5_PASS, T5_SALT, String(T5_ITERS), String(T5_LEN)]);
    const kdfTon = ossl(openssl, [
      "kdf",
      "-keylen", String(T5_LEN),
      "-kdfopt", "digest:SM3",
      "-kdfopt", `pass:${T5_PASS}`,
      "-kdfopt", `hexsalt:${T5_SALT}`,
      "-kdfopt", `iter:${T5_ITERS}`,
      "PBKDF2",
    ]);
    ran++;
    // Tongsuo 的 `kdf` 输出是 `AA:BB:…` 形式 ⇒ 去分隔符再比（比的是字节，不是打印格式）
    const kdfTonHex = kdfTon ? String(kdfTon).replace(/[\s:]/g, "").toLowerCase() : null;
    if (!kdfRust || kdfRust.length !== T5_LEN * 2) {
      fail(`T5①：夹具 KDF 输出长度不对（${kdfRust ? kdfRust.length : "无输出"} 字符，期望 ${T5_LEN * 2}）`);
    } else if (kdfTonHex !== kdfRust) {
      fail(
        `T5①：PBKDF2-HMAC-SM3 两侧不一致 —— RustCrypto ${kdfRust.slice(0, 32)}… vs Tongsuo ${
          kdfTonHex ? kdfTonHex.slice(0, 32) + "…" : "(无输出)"
        }`,
      );
    }
    // ② 口径 1：SM4 的密钥 = KDF 输出的**前 16 字节**（不是前 32 —— SM4 是 128 位）
    ran++;
    const sm4KeyDerived = kdfRust ? kdfRust.slice(0, 32) : null;
    const ctRustDerived = sm4KeyDerived ? gm(["enc", sm4KeyDerived, IV, ptFile]) : null;
    const ctTonDerived = sm4KeyDerived
      ? ossl(openssl, ["enc", "-sm4-cbc", "-K", sm4KeyDerived, "-iv", IV, "-in", ptFile])
      : null;
    if (!ctRustDerived || !ctTonDerived) {
      fail("T5②：用 KDF 前 16 字节当 SM4 密钥的 CBC 加密没有输出");
    } else if (hex(ctTonDerived) !== ctRustDerived) {
      fail(
        `T5②：「SM4 取前 16 字节」两侧密文不同 —— Tongsuo ${hex(ctTonDerived).slice(0, 32)}… vs RustCrypto ${ctRustDerived.slice(0, 32)}…`,
      );
    }
    // ③ 口径 1 的另一半：HMAC-SM3 的密钥 = KDF 输出的**后 32 字节**
    ran++;
    const macKeyDerived = kdfRust ? kdfRust.slice(64, 128) : null;
    const macRustDerived = macKeyDerived ? gm(["hmac", macKeyDerived, macFile]) : null;
    const macTonDerived = macKeyDerived
      ? ossl(openssl, ["dgst", "-sm3", "-mac", "HMAC", "-macopt", `hexkey:${macKeyDerived}`, macFile])
      : null;
    const macTonDerivedHex = macTonDerived ? String(macTonDerived).trim().split(/\s+/).pop() : null;
    if (!macRustDerived || macRustDerived !== macTonDerivedHex) {
      fail(`T5③：「MAC 取后 32 字节」两侧不一致 —— RustCrypto ${macRustDerived} vs Tongsuo ${macTonDerivedHex}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ★ "空跑即红"：跑到的用例数必须达到下限（夹具被删/命令面变了 ⇒ 这里先红）
if (ran < minCases) fail(`只跑成 ${ran} 个用例（下限 ${minCases}）—— 判据在空转，先修夹具/驱动`);

for (const s of skips) console.error(`! ${s}`);
if (problems.length) {
  console.error(`gm-conformance: ❌ 不通过（跑成 ${ran} 个用例）`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `gm-conformance: ✅ 通过 —— 跑成 ${ran} 个用例${skips.length ? "（另有跨实现对拍跳过，见上面的 ! 行）" : "（含跨实现对拍）"}`,
);
console.log(`  R1/R2 GM/T 0002+0004 标准向量 · R3 SM4-CBC+PKCS#7 往返 · R4 HMAC-SM3 确定性`);
if (skips.length === 0) console.log(`  T1–T5 Tongsuo 对拍：标准向量 / 双向互解 / 密文逐字节相同 / HMAC 一致 / PBKDF2-HMAC-SM3 与拆 key 口径`);

/** 探一下这个 openssl 有没有 sm4-cbc（系统自带的 OpenSSL 通常**没有** —— 那正是要 Tongsuo 的原因）。 */
// ⚠️ 这个探针**曾经是坏的**（2026-09-19：两侧各自独立踩到 —— AMD 用 WSL2 的真 Tongsuo、
//    macOS 侧用本机编的 Tongsuo，都是"拿真货跑这条门禁"才当场发现的）：
//    它原来喂 8 字节（`Buffer.from("0123456789abcdef","hex")`）给 `-nopad` 的 SM4-ECB 探针 ——
//    8 字节不是分组整数倍 ⇒ openssl 退出码非 0 ⇒ 探针恒 false ⇒ **整段 T 分支永远走"跳过"那一支**。
//    后果不是红，而是"给了 Tongsuo 也照样绿并自报跳过"：判据看起来在岗，其实从来没开过火。
//    修法：① 喂**恰好一个分组**的明文（标准向量那 16 字节）**并断言等于期望密文**（只比长度的话，
//    一个错实现也能过）；② 让"**指名了 Tongsuo 却用不了**"直接红（见调用处），不再退化成跳过。
function probeSm4Cbc(openssl) {
  const probeFile = join(tmpdir(), `gm-probe-${process.pid}.bin`);
  try {
    // ⚠️⚠️ **16 字节 = SM4 一个块**，不是 16 个十六进制**字符**。
    //    2026-09-19 这一处原写成 `Buffer.from("0123456789abcdef","hex")`（8 字节）⇒ `-nopad` 下
    //    必然 "data not multiple of block length" ⇒ 探针**恒假** ⇒ **整段 T 分支静默跳过**，
    //    而门禁照样绿（打印成"跑成 3 个用例（另有对拍跳过）"）。两侧**各自独立**发现了同一个 bug
    //    （AMD 拿 WSL2 的真 Tongsuo、macOS 侧拿本机编的 Tongsuo），合并时取这一份：
    //    喂的是标准向量那 16 字节，且**断言等于期望密文**（只比长度的话，错实现也能过）。
    writeFileSync(probeFile, Buffer.from(KEY, "hex")); // KEY 的十六进制字节 = 16 字节 = 一个 SM4 分组
    const out = execFileSync(openssl, ["enc", "-sm4-ecb", "-K", KEY, "-nopad", "-in", probeFile], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const got = Buffer.from(out);
    if (got.length !== 16) return { ok: false, why: `SM4-ECB 一个分组应吐 16 字节，实际 ${got.length} 字节` };
    const hexed = got.toString("hex");
    if (hexed !== EXP_ECB) return { ok: false, why: `SM4-ECB 标准向量对不上（得 ${hexed}，期望 ${EXP_ECB}）` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e.message).split("\n")[0] };
  } finally {
    rmSync(probeFile, { force: true });
  }
}
