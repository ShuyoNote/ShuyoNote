// 门禁：**移动端自己的版号**（阶段 3「交付单立」✓，R204 owner 拍「从当前桌面号分叉」✓）。
//
// ## 它挡的是哪一次真事故（`incident`，⛔ 不是装饰 ✗）
// 移动端此前**没有自己的版号** ✗ —— 它只能跟着桌面号走 ✓，而 Android 上 `tauri.properties` 的
// `tauri.android.versionName` **没有**对应的 Tauri 配置字段 ✓（证据逐字：`node_modules/@tauri-apps/cli/
// config.schema.json:34`「**Android**: … By default version 1.0 is used on Android」✓）⇒ 于是"移动独立版号"
// 只能靠**独立的事实源 ＋ 写入脚本**送进 APK ✓（阶段 3【1】已落地 `mobile-version.json` ＋
// `scripts/write-mobile-version.mjs` ✓）。⇒ 本门禁钉的是**它的形状**：
// ① 事实源**恰好一处** ✓（否则又是两份真相源 ✓ —— 本仓花最大代价消灭的东西 ✓）；
// ② ⛔ **不许是桌面 `APP_VERSION` 的别名** ✗（那就名存实亡 ✓，等于"独立"没发生 ✓）；
// ③ ⭐ **不许低于当前桌面号** ✓（R204 的硬规矩 ✓：手机上装的是 1.92.x ✓，往回跳会让用户看到"版本变低"✓）。
//
// ## ⚠️ 与那个脚本里的护栏**不是一回事**（两条别混 ✓）
// `scripts/write-mobile-version.mjs` 里也有一条"低于桌面号 ⇒ 拒绝"✓ —— 那是**运行期**护栏 ✓；
// 本条是**纯静态源码扫描** ✓（⛔ 不调用那个脚本 ✗）⇒ 它在本机/CI 都能跑、不依赖任何构建 ✓。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 不算通过（事实源读不到 ⇒ 不是干净 ✗）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** ⭐ 允许的"移动版号事实源"**显式清单**（棘轮：长度只增不减 ✓ —— 加一个必须同时改常量 ✓）。 */
const SOURCES = ["mobile-version.json"];
/** ⭐ 长度常量（棘轮的那一半 ✓）：加一行必改它 ⇒ **悄悄加不了** ✗。 */
const SOURCES_EXPECTED = 1;
/** 字段名（事实源里那一个键 ✓）。 */
const FIELD = "mobileVersion";

const findings = [];
const num = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => {
  const x = num(a);
  const y = num(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

// ── 棘轮 ──
if (SOURCES.length !== SOURCES_EXPECTED) {
  console.error(`❌ 事实源清单长度 ${SOURCES.length} ≠ 常量 ${SOURCES_EXPECTED} —— 加源必须同时改常量（棘轮 ✓，⛔ 不许悄悄加 ✗）`);
  process.exit(1);
}

// ── ① 事实源恰好一处 ──
let mobileVersion = null;
try {
  mobileVersion = JSON.parse(readFileSync(resolve(REPO_ROOT, SOURCES[0]), "utf8"))[FIELD];
} catch (e) {
  console.error(`❌ 不算通过：读不到事实源 ${SOURCES[0]}（${String(e).slice(0, 80)}）—— 这不是干净 ✗`);
  process.exit(2);
}
if (typeof mobileVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(mobileVersion)) {
  findings.push(`${SOURCES[0]}：\`${FIELD}\` 必须是非空的 x.y.z 字符串（实际 ${JSON.stringify(mobileVersion)}）`);
}
// 全仓：还有没有**别的**文件也定义这个键 ✗（两份真相源 ✓）
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git" || n === "dist" || n === "dist-web" || n === "target") continue;
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(json|ts|tsx|mjs|js)$/.test(n)) out.push(p);
    } catch {}
  }
  return out;
};
const files = walk(REPO_ROOT);
const definesField = files.filter((f) => new RegExp(`"${FIELD}"\\s*:`).test(readFileSync(f, "utf8")));
const allowed = SOURCES.map((s) => resolve(REPO_ROOT, s));
for (const f of definesField) {
  if (!allowed.includes(f)) findings.push(`${f.replace(REPO_ROOT + "/", "")}：**又一个** \`"${FIELD}":\` 定义 ⇒ 两份真相源 ✗（本仓花最大代价消灭的东西 ✓）`);
}

// ── ② ⛔ 不许是 `APP_VERSION` 的别名 ──
const codeFiles = files.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\./.test(f));
const ALIAS = /(mobileVersion|MOBILE_APP_VERSION)\s*[:=]\s*[^;\n]*APP_VERSION\b/;
for (const f of codeFiles) {
  const src = readFileSync(f, "utf8");
  if (ALIAS.test(src)) {
    findings.push(`${f.replace(REPO_ROOT + "/", "")}：把移动版号**绑成** \`APP_VERSION\` 的别名 ✗（那就等于"独立"没发生 ✓）`);
  }
}

// ── ③ ⭐ 不许低于当前桌面号（R204 ✓）──
const desktop = String(JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).version || "");
if (mobileVersion && desktop && cmp(mobileVersion, desktop) < 0) {
  findings.push(`移动版号 ${mobileVersion} **低于**桌面号 ${desktop} ⇒ ⛔ 不许往回跳 ✗（R204：手机上装的是 ${desktop.split(".").slice(0, 2).join(".")}.x ✓）`);
}

if (findings.length) {
  console.error("❌ 不算通过：移动版号的形状不对（⛔ 独立标识 ＋ 不往回跳 ✗）：");
  for (const f of findings) console.error(`   ${f}`);
  process.exit(1);
}

console.log(
  `✓ 干净：移动版号 ${mobileVersion} ✓（来源 ${SOURCES[0]} ✓，定义恰好一处 ✓）；` +
    `桌面号 ${desktop} ⇒ 未低于它 ✓；⛔ 不是 \`APP_VERSION\` 的别名 ✗`,
);
