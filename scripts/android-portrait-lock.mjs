// 安卓**竖屏锁**：给生成的清单里那个 `MainActivity` 钉上 `android:screenOrientation="portrait"`。
//
// 为什么要有这个脚本（而不是手改 gen/android）：`src-tauri/gen` 被 gitignore（`.gitignore:59`），
// 手改**不进库**，`tauri android init` 一跑就没 —— 与 `android-splash-theme.mjs` 同一个理由。
//
// 为什么锁：owner 2026-09-25 拍板「**手机端锁竖屏**」。依据是实测：生成的清单里**没有任何**
// `android:screenOrientation`，而 `MainActivity` 的 `configChanges` **包含 `orientation`**
// （⇒ 转屏时 Activity 不重建、WebView 直接跟着重排）—— 而移动壳的窄屏布局是照**竖屏**做的，
// 没有任何横屏设计。⚠️ 平板/折叠屏将来若要横屏，应另开一条按机型/资源目录区分的口径，**不要**改这里。
//
// 用法：
//   node scripts/android-portrait-lock.mjs           # 写入（幂等）
//   node scripts/android-portrait-lock.mjs --check   # 只校验（没钉上 ⇒ exit 1）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
const CHECK = process.argv.includes("--check");

const PIN = 'android:screenOrientation="portrait"';
/// 唯一的锚点：`.MainActivity` 这个 `name` 只出现一次，插在它前面 ⇒ 一定落在那个 `<activity>` 里。
const ANCHOR = 'android:name=".MainActivity"';

if (!existsSync(MANIFEST)) {
  console.error(`✗ 找不到清单：${MANIFEST}`);
  console.error("  先跑 `tauri android init`（gen/ 不进库）。");
  process.exit(2);
}

const src = readFileSync(MANIFEST, "utf8");
const already = src.includes(PIN);

if (already) {
  console.log(CHECK ? "✓ 竖屏锁已在清单里" : "✓ 竖屏锁已在清单里（无需改动）");
  process.exit(0);
}

if (CHECK) {
  console.error(`✗ 清单里没有 ${PIN} ⇒ 跑 \`node scripts/android-portrait-lock.mjs\`（gen/ 不进库，这是正常的）。`);
  process.exit(1);
}

if (!src.includes(ANCHOR)) {
  console.error(`✗ 清单里找不到锚点 ${ANCHOR} —— Tauri 的模板变了？先看一眼再改，别盲插。`);
  process.exit(1);
}

// 插在 `android:name` 前一行（缩进照原样对齐，纯字符串操作、不解析 XML ⇒ 不会重排别的属性）。
const indent = "              ";
const patched = src.replace(ANCHOR, `${PIN}\n${indent}${ANCHOR}`);
if (patched === src) {
  console.error("✗ 替换没有生效（锚点没匹配上）—— 没改动任何文件。");
  process.exit(1);
}
writeFileSync(MANIFEST, patched, "utf8");
console.log(`✓ 已写入 ${PIN}（锚点 ${ANCHOR}）`);
