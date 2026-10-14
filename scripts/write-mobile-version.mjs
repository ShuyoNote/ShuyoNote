// ⭐ 阶段 3【1】（R204 owner 拍「从当前桌面号分叉」✓）：把**移动自己的版号**写进 `tauri.properties`。
//
// 为什么是 `tauri.properties`：Tauri 的 Android 生成器读它 ⇒ `app/build.gradle.kts:24-25` 逐字
//   `versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1")` ✓
//   `versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")` ✓
//   ⇒ ⭐ 所以写它 = 把号送进 **APK 的 `versionName`/`versionCode`** ✓
//   （⚠️ 证据：`node_modules/@tauri-apps/cli/config.schema.json:34` 逐字「**Android**: … By default
//     version 1.0 is used on Android」✗ ⇒ Tauri **没有** `versionName` 专用配置字段 ✓ ⇒ 只能由这份文件送 ✓）
//
// ⛔ **本脚本本轮【不接线】** ✗：⛔ 不动 `vite.config.ts`／`src/lib/links.ts`／任何 workflow ✓ ——
//    那三处是【3】✓。⇒ ⚠️ **它现在没有调用者** ✓（这是刻意的：先把事实源与脚本立稳 ✓）。
//
// 用法（照仓里先例 `scripts/write-version-json.mjs` 的形状 ✓：无参 ⇒ 写默认产物 ✓）：
//   node scripts/write-mobile-version.mjs                  # 写 src-tauri/gen/android/app/tauri.properties
//   node scripts/write-mobile-version.mjs --out <路径>      # 写别处（CI 用不着；自测/演练用 ✓）
//
// ⚠️ 幂等 ✓：读-改-写，只替换那两行 ✓（连跑两次内容逐字相同 ✓）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 事实源：mobile-version.json（⛔ 不是 package.json 的别名 ✗）──
const srcPath = resolve(root, "mobile-version.json");
const src = JSON.parse(readFileSync(srcPath, "utf8"));
const mobileVersion = String(src.mobileVersion || "");
if (!/^\d+\.\d+\.\d+$/.test(mobileVersion)) {
  console.error(`[mobile-version] ⛔ mobile-version.json 的 mobileVersion 不是 x.y.z：${JSON.stringify(src.mobileVersion)}`);
  process.exit(1);
}

// ── ⭐ 与 Tauri **同规则**（config.schema.json:3908-3909 逐字：
//      versionCode = version.major*1000000 + version.minor*1000 + version.patch ✓）
//    ⇒ 同规则才不会与 CLI 自己那套打架 ✓
const [major, minor, patch] = mobileVersion.split(".").map(Number);
const versionCode = major * 1000000 + minor * 1000 + patch;

// ── ⭐ R204 的硬规矩：**不许低于当前桌面号**（⛔ 手机上装的是 1.92.x ✗ ⇒ 往回跳 = 用户看到"版本变低"✓）──
const desktop = String(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version || "");
const num = (v) => String(v).split(".").map(Number);
const cmp = (a, b) => {
  const x = num(a);
  const y = num(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
if (desktop && cmp(mobileVersion, desktop) < 0) {
  console.error(`[mobile-version] ⛔ 移动版号 ${mobileVersion} **低于**桌面号 ${desktop} —— R204：⛔ 不许往回跳 ✗`);
  process.exit(1);
}

// ── 产物：读-改-写（只替换那两行 ⇒ 幂等 ✓；别的行原样保留 ✓）──
const at = process.argv.indexOf("--out");
const out = at > -1 ? resolve(process.argv[at + 1]) : resolve(root, "src-tauri", "gen", "android", "app", "tauri.properties");
const keep = existsSync(out)
  ? readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !/^tauri\.android\.version(Name|Code)=/.test(l))
  : [];
const body = [...keep, `tauri.android.versionName=${mobileVersion}`, `tauri.android.versionCode=${versionCode}`].join("\n") + "\n";
writeFileSync(out, body);

console.log(`[mobile-version] ${out}\n  → versionName=${mobileVersion} versionCode=${versionCode}（桌面号 ${desktop} ✓ 未低于它 ✓）`);
