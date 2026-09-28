// 安卓**开屏（splash）**的生成器：把主题的背景从"Material 默认白"换成**品牌色 ＋ 居中图标**。
//
// 为什么要有这个脚本（而不是手改 gen/android）：
//   1. **`src-tauri/gen` 被 gitignore**（`.gitignore:59`）⇒ 手改不进库，`tauri android init` 一跑就没；
//   2. 仓里原先**没有任何脚本**写 `res/values/themes.xml`（图标有 `android-app-icon.mjs`、
//      移动壳有 `android-mobile-shell.mjs`，主题没有）⇒ 它是唯一一处"只在机器上存在"的界面配置。
//
// 为什么值得做：真机（Xiaomi MIX 2 / Android 9）实测启动瞬间有一个**系统开屏窗口**：
//   `Window{… u0 Splash Screen cn.shuyo.shuyonote EXITING} ty=APPLICATION_STARTING wanim=… animation-leash`
//   而我们的主题是模板默认（**没有 `windowBackground`、没有 Android 12 的 splash 属性**）
//   ⇒ 那几百毫秒里就是**一块白**（`document.body` 也是 `rgb(255,255,255)`），观感即"开屏没铺满"。
//   注意：**MIUI 那段从图标展开的动画是系统侧的，改不了**；能改的是它演的"底"。
//
// 用法：
//   node scripts/android-splash-theme.mjs           # 写入（幂等）
//   node scripts/android-splash-theme.mjs --check   # 只校验，不写（不一致 ⇒ exit 1）
//
// ⚠️ 它**不**碰 `themes.xml` 里除自己那几行以外的内容：先读进来，只在缺失时补属性、
//    并把自己生成的那几个文件整份重写（带 `shuyonote:splash` 标记，便于核对来源）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RES = join(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "res");
const CHECK = process.argv.includes("--check");

/// 品牌色 = 亮色主题的 `--accent`（`src/App.css:21`）。开屏只有一个底，不跟主题分叉。
const BRAND = "#3370ff";
const ICON = "@mipmap/ic_launcher";

// ⚠️ 第一版这里是个 `layer-list`（品牌底 ＋ `<bitmap android:src="@mipmap/ic_launcher">` 居中图标），
//    在真机上**开窗当场崩**：`LayerDrawable.inflateLayers → Drawable.createFromXmlInner` 抛异常。
//    原因：API 26+ 的 `@mipmap/ic_launcher` 解析到的是 **adaptive-icon XML**，而 `<bitmap>` 只吃位图。
//    ⇒ 老平台那条路只放**纯色**（零解析风险）；图标只写给 Android 12+ 的
//    `windowSplashScreenAnimatedIcon`（那个属性本来就接受 adaptive icon，是它的正常用法）。
const COLORS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 由 scripts/android-splash-theme.mjs 生成：开屏底色（= 品牌色） -->
    <color name="shuyonote_splash_background">${BRAND}</color>
</resources>
`;

/// 基础主题：pre-API-31 的平台（含真机那台 Android 9）看的就是 `windowBackground`。
function themeBase() {
  return `<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- 由 scripts/android-splash-theme.mjs 生成/维护。 -->
    <style name="Theme.shuyonote" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <!-- 开屏底：**纯品牌色**（老平台只认这一条；放位图会在开窗时崩，见脚本头注释） -->
        <item name="android:windowBackground">@color/shuyonote_splash_background</item>
    </style>
</resources>
`;
}

/// API 31+ 的系统 splash：背景色 ＋ 动画图标（不写这两条的话，Android 12+ 会用默认白底/默认图标）。
function themeV31() {
  return `<resources xmlns:tools="http://schemas.android.com/tools">
    <!-- 由 scripts/android-splash-theme.mjs 生成/维护：Android 12+ 的系统 splash 属性。 -->
    <style name="Theme.shuyonote" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowBackground">@color/shuyonote_splash_background</item>
        <item name="android:windowSplashScreenBackground">@color/shuyonote_splash_background</item>
        <item name="android:windowSplashScreenAnimatedIcon">${ICON}</item>
    </style>
</resources>
`;
}

const FILES = [
  ["values/colors_splash.xml", COLORS],
  ["values/themes.xml", themeBase()],
  ["values-night/themes.xml", themeBase()],
  ["values-v31/themes.xml", themeV31()],
];

/// 第一版留下的 layer-list（会让开窗崩）——生成器负责把它清掉，免得老机器上留着旧文件继续崩。
const OBSOLETE = ["drawable/splash_background.xml"];

if (!existsSync(RES)) {
  console.error(`✗ 找不到安卓资源目录：${RES}`);
  console.error("  先跑 `tauri android init`（gen/ 不进库，换机器/重新 init 后本脚本要再跑一次）。");
  process.exit(2);
}

let drifted = 0;
let written = 0;
for (const rel of OBSOLETE) {
  const abs = join(RES, rel);
  if (!existsSync(abs)) continue;
  if (CHECK) {
    drifted++;
    console.error(`✗ ${rel} 是**会导致开窗崩溃**的旧文件，必须删掉`);
    continue;
  }
  rmSync(abs);
  console.log(`  删除过时的 ${rel}（layer-list 在位图上会崩）`);
}
for (const [rel, content] of FILES) {
  const abs = join(RES, rel);
  const cur = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (cur === content) continue;
  if (CHECK) {
    drifted++;
    console.error(`✗ ${rel} 与生成结果不一致` + (cur === null ? "（文件不存在）" : ""));
    continue;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  written++;
  console.log(`  写入 ${rel}`);
}

if (CHECK) {
  if (drifted) {
    console.error(`\n开屏主题漂了 ${drifted} 处 ⇒ 跑 \`node scripts/android-splash-theme.mjs\` 重写（gen/ 不进库，这是正常的）。`);
    process.exit(1);
  }
  console.log(`✓ 开屏主题与生成结果一致（${FILES.length} 个文件）`);
} else {
  console.log(`✓ 开屏主题已就位（写 ${written} 个，共 ${FILES.length} 个；品牌色 ${BRAND}）`);
}
