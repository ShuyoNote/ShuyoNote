// 给「生成出来的」Android 工程写上**应用显示名**（`app_name` / `main_activity_title`）。
//
// ## 为什么需要脚本（2026-09-22，owner 拍板「方案 A」）
//
// 备案要的是**四处同名**：**安装后图标下方那行字** ＝ 工信部 App 备案的「App 名称」
// ＝ 商店上架名 ＝ 软著全称（`ShuyoNote 数友笔记`，见 `docs/softcopyright/README.md`）。
// 依据：阿里云 App 备案 FAQ 对「App 名称」的定义就是「App 安装后图标下方所显示的名称」，
// 且在每个 App 主办者下唯一 ⇒ 名字对不上时，商店/管局那一关要花口舌解释"包含关系"。
//
// 而 `tauri android init` 每次都把 `tauri.conf.json` 的 `productName`（`ShuyoNote`）
// 写进 `gen/android/app/src/main/res/values/strings.xml`，`src-tauri/gen` 又**不进 git**
// ⇒ 手工改必丢。做法与 `android-app-icon.mjs` / `android-mobile-shell.mjs` 同源：
// **内容写在本文件里，每次 init 之后跑一遍，`--check` 给门禁用。**
//
// ## 为什么不直接把 `productName` 改成中文全称
//
// `productName` 同时决定**桌面端安装包与更新清单的文件名**（`ShuyoNote_1.91.x_x64-setup.exe`
// 那套），改它会动到发版链与既有更新通道 ⇒ 本脚本**只改 Android 这一处显示名**。
// 桌面端不进 App 备案，不必跟着改。
//
// ## 用法
//
//   node scripts/android-app-name.mjs            # 写显示名（幂等）
//   node scripts/android-app-name.mjs --check     # 只核对（给门禁用，不写文件）
// 退出码：0 = 就位/一致；1 = 名字不对或 strings.xml 里缺这两个字符串；2 = **没验**（工程不存在）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/is-main.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * App 显示名 —— **四处同源**（2026-09-22 定，方案 A）。
 * ⚠️ 改这里就等于改备案材料里「App 名称」那一栏（备案一旦提交，改名要提**备案变更**）。
 */
export const APP_NAME = "ShuyoNote 数友笔记";

/** 目标文件（相对仓库根；`android init` 生成，不入库）。 */
export const STRINGS_REL = join("src-tauri", "gen", "android", "app", "src", "main", "res", "values", "strings.xml");

/** 要同名的两个字符串：一个管桌面图标下的名字，一个管任务/窗口标题。 */
export const NAME_KEYS = ["app_name", "main_activity_title"];

/**
 * 纯函数：把 `strings.xml` 里 `app_name` / `main_activity_title` 的值换成 `name`。
 *
 * @param {string} xml 原文
 * @param {string} name 目标显示名
 * @returns {{xml:string, changed:boolean, missing:string[]}} `missing` 非空 = 这个 xml 不是我们认识的形状（**不静默过**）
 *
 * 细节：tauri 写进去的值**带一对字面引号**（`"ShuyoNote"`），那是 Android 资源里
 * "别 trim 我" 的写法 ⇒ 这里保持同一形态（`"名字"`），不改成裸文本。
 */
export function setNameInStrings(xml, name) {
  const wanted = `"${name}"`;
  const missing = [];
  let changed = false;
  let next = xml;
  for (const key of NAME_KEYS) {
    const re = new RegExp(`(<string\\s+name="${key}"\\s*>)([\\s\\S]*?)(</string>)`);
    const m = re.exec(next);
    if (!m) {
      missing.push(key);
      continue;
    }
    if (m[2] === wanted) continue;
    next = next.slice(0, m.index) + m[1] + wanted + m[3] + next.slice(m.index + m[0].length);
    changed = true;
  }
  return { xml: next, changed, missing };
}

/**
 * 写显示名 / 核对显示名。
 * @param {{root?:string, check?:boolean, log?:Function, err?:Function}} [opts]
 */
export function stageAppName({ root: repoRoot = root, check = false, log = console.log, err = console.error } = {}) {
  const file = join(repoRoot, STRINGS_REL);
  if (!existsSync(file)) {
    err(`✗ 没验：找不到 ${file}`);
    err("  ⇒ 先跑 `pnpm tauri android init`（它生成 gen/android；该目录不进 git），再跑本脚本。");
    return 2;
  }

  const { xml, changed, missing } = setNameInStrings(readFileSync(file, "utf8"), APP_NAME);
  if (missing.length > 0) {
    err(`✗ ${STRINGS_REL} 里缺少 ${missing.join(" / ")} —— \`tauri android init\` 生成的 strings.xml 本应有这两条`);
    err("  ⇒ 按「找不到就报错」处理（不静默过）：这个形状变了就该有人来看一眼，而不是把名字这件事悄悄放过去。");
    return 1;
  }

  if (check) {
    if (changed) {
      err(`✗ Android App 显示名不是「${APP_NAME}」（现在还是 \`tauri init\` 写的 productName）`);
      err("  为什么重要：备案的「App 名称」＝ 安装后图标下方那行字 ＝ 商店上架名 ＝ 软著全称，");
      err("  四处对不上时，商店/管局审核要多花口舌解释（owner 2026-09-22 选了「方案 A：四处同名」）。");
      err("  ⇒ 跑 `pnpm android:app-name`（每次 `tauri android init` 之后都要）。");
      return 1;
    }
    log(`✓ Android App 显示名已就位（app_name / main_activity_title = ${APP_NAME}）`);
    return 0;
  }

  if (changed) {
    writeFileSync(file, xml, "utf8");
    log(`✓ 已把 Android App 显示名改成「${APP_NAME}」→ ${STRINGS_REL}`);
  } else {
    log(`✓ Android App 显示名本就是「${APP_NAME}」（未改动）`);
  }
  log("   ⚠️ `gen/android` 不进 git：**每次 `tauri android init` 之后都要再跑一次这一步**" +
    "（CI 里是 init 之后紧跟着跑；见 .github/workflows/android.yml / release.yml）。");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exit(stageAppName({ check: process.argv.slice(2).includes("--check") }));
}
