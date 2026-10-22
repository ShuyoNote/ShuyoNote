#!/usr/bin/env node
// 门禁：**每个移动屏都必须有 ≥1 条「回家的路」**。
//
// 为什么有这一条（2026-10-22，owner 拍板「按你的建议执行」）：
//   1) 2026-10-10 出过一次**真死路**（台账 R188 的 (b)）：快速记录存完落进编辑器，而那个屏
//      按返回键**直接退出应用**、`am start` 重启**仍回编辑器**、抽屉里**没有「首页」**
//      ⇒ 除 `pm clear` 没有回家的路。当时的补救是加一颗 `position: fixed` 的「‹ 首页」浮标。
//   2) 2026-10-22 复核：两条真路都已建好（阅读屏顶栏「‹ 阅读」＋ 底栏三格）⇒ 浮标**冗余**
//      （压在正文右下角，还让"回家"有两个入口）⇒ 删掉。
//   3) ⚠️ **删浮标的前提是这条判据先存在** —— 否则删它只是把"某屏回不去"这个问题**藏起来**
//      （浮标曾经替所有屏兜底，删了以后谁漏了都没人发现）。所以这一条与那笔删除**同批**落地。
//
// 判据是**机械**的：每个屏文件必须至少出现一种"回家"的写法 ——
//   ① 它被 `App.tsx` 的 `wrapMobile(<屏 />)` 包着 ⇒ **底栏三格**在它上面，回家可达 ✓
//   ② 源码里有 `setScreen("home")` ／ `goHome` ／ `closeSettings` ⇒ 屏内**显式**路 ✓
//   ③ 源码里有返回键（`aria-label="返回…"` 或 `className="m…-back"`）⇒ **返回键** ✓
//   ④ 在 `EXEMPT` 里显式声明（带 `why`）—— 目前**空表**，且 `EXEMPT_EXPECTED = 0`
//      （棘轮：要加先改常量，改常量等于人拍一次 —— 与 `check-mobile-class-namespace` 同写法）
//
// ⛔ 刻意**不做**的事：不扫 CSS、不猜"这个屏看起来有返回键"、不把"底栏其实被隐藏了"算作路
//    （那要靠 `verify-mobile-*` 那套真实 Chromium 的读数；本门禁只钉"代码里有没有这条意图"）。
//
// 退出码（与仓里其它 check-*.mjs 一致）：0 干净／1 有发现／2 环境不具备／3 无可检查对象
// 用法：
//   node scripts/check-mobile-exit-routes.mjs
//   node scripts/check-mobile-exit-routes.mjs --self-test
//   node scripts/check-mobile-exit-routes.mjs --dir <另一个仓库根>   # 夹具用

import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 不是"屏"的组件 —— 每一项都要写明理由（⛔ 不许因为红就塞进来）。 */
const NON_SCREENS = {
  MobileHome: "首页**本身** —— 它就是那个目的地，不需要回家的路",
  MobileTabBar: "底栏**本身**（导航条）—— 它是路，不是屏",
  MobileDictCard: "**卡片**（压在阅读屏上的词条卡，`06-dict.svg`）—— 不是独立屏",
  MobileMergeHistory: "**未接线原型**（没有任何入口渲染它）—— 接线那天要从这里挪出去",
};

/** 例外白名单（声明式豁免）。⚠️ 棘轮：加一条必须同时改下面的常量。 */
const EXEMPT = {};
const EXEMPT_EXPECTED = 0;

const ROUTE_DOC = {
  wrap: "底栏三格（被 App.tsx 的 wrapMobile 包着）",
  screen: "屏内显式（setScreen(\"home\") / goHome / closeSettings）",
  back: "返回键（aria-label=\"返回…\" 或 m*-back 类）",
  exempt: "声明式豁免",
};

function verdict(code) {
  if (code === 0) return "干净";
  if (code === 1) return "有发现";
  if (code === 2) return "环境不具备";
  return "无可检查对象";
}

/** 纯函数：给定一个屏的源码与「是否被 wrapMobile 包着」⇒ 回家的路（或 null）。 */
export function routeOf(source, wrapped) {
  if (wrapped) return "wrap";
  if (/setScreen\(\s*"home"\s*\)/.test(source) || /\bgoHome\b/.test(source) || /\bcloseSettings\b/.test(source)) {
    return "screen";
  }
  if (/aria-label="返回/.test(source) || /className="m[a-zA-Z-]*-back"/.test(source)) return "back";
  return null;
}

/** 纯函数：扫一个仓库根 ⇒ { rows, missing }。 */
export function scan(root) {
  const compDir = join(root, "src", "components");
  if (!existsSync(compDir)) return { envMissing: `没有 ${compDir}` };
  const appPath = join(root, "src", "App.tsx");
  const app = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";

  const files = readdirSync(compDir).filter((f) => /^Mobile.*\.tsx$/.test(f) && !/\.test\./.test(f));
  const rows = [];
  const missing = [];
  for (const f of files) {
    const name = f.replace(/\.tsx$/, "");
    if (NON_SCREENS[name]) {
      rows.push({ name, route: null, why: NON_SCREENS[name], isScreen: false });
      continue;
    }
    const src = readFileSync(join(compDir, f), "utf8");
    const wrapped = new RegExp(`wrapMobile\\(\\s*<${name}\\b`).test(app);
    let route = routeOf(src, wrapped);
    let why = route ? ROUTE_DOC[route] : "";
    if (!route && EXEMPT[name]) {
      route = "exempt";
      why = EXEMPT[name];
    }
    rows.push({ name, route, why, isScreen: true });
    if (!route) missing.push(name);
  }
  return { rows, missing, screenCount: rows.filter((r) => r.isScreen).length };
}

function printTable(rows) {
  for (const r of rows) {
    if (!r.isScreen) {
      console.log(`  · ${r.name.padEnd(22)} —— 不是屏：${r.why}`);
      continue;
    }
    const mark = r.route ? "✓" : "✗";
    console.log(`  ${mark} ${r.name.padEnd(22)} ${r.why || "**没有任何回家的路**"}`);
  }
}

function run(root) {
  const r = scan(root);
  if (r.envMissing) {
    console.error(`check-mobile-exit-routes: ${r.envMissing}`);
    console.error("结果：环境不具备（不算通过）");
    return 2;
  }
  console.log("check-mobile-exit-routes: 每个移动屏都必须有 ≥1 条「回家的路」");
  printTable(r.rows);
  const exemptCount = Object.keys(EXEMPT).length;
  if (exemptCount !== EXEMPT_EXPECTED) {
    console.error(
      `❌ 豁免表有 ${exemptCount} 条，而常量是 ${EXEMPT_EXPECTED} —— 加/删豁免必须同时改常量（棘轮：⛔ 不许悄悄加）`,
    );
    console.error("结果：有发现");
    return 1;
  }
  if (r.screenCount === 0) {
    console.log("结果：无可检查对象（一个屏都没扫到）—— 不算通过");
    return 3;
  }
  if (r.missing.length > 0) {
    console.error(`\n❌ 这些移动屏**没有任何回家的路**：${r.missing.join("、")}`);
    console.error("  ⇒ 要么加明显的回家路（返回键／底栏／屏内按钮），要么在 EXEMPT 里写明理由并改常量");
    console.error("结果：有发现");
    return 1;
  }
  console.log(`\n结果：干净（${r.screenCount} 个屏，每个都有 ≥1 条回家的路；豁免 ${exemptCount} 条）`);
  return 0;
}

// ---------------- 自测（夹具：临时目录里造 3 种屏） ----------------
function selfTest() {
  const cases = [];
  const build = (files, app) => {
    const dir = mkdtempSync(join(tmpdir(), "mor-exit-"));
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "src", "components", name), body, "utf8");
    writeFileSync(join(dir, "src", "App.tsx"), app || "", "utf8");
    return dir;
  };
  try {
    // ① 有返回键 ⇒ 干净
    let d = build({ "MobileAlpha.tsx": 'export function MobileAlpha(){ return <button aria-label="返回上一屏">‹</button>; }' });
    cases.push(["有返回键 ⇒ 0", scan(d).missing.length === 0]);
    rmSync(d, { recursive: true, force: true });
    // ② 被 wrapMobile 包着 ⇒ 干净（底栏就在它上面）
    d = build(
      { "MobileBeta.tsx": "export function MobileBeta(){ return <div/>; }" },
      'const x = wrapMobile(<MobileBeta />, {});',
    );
    cases.push(["被 wrapMobile 包着 ⇒ 0", scan(d).missing.length === 0]);
    rmSync(d, { recursive: true, force: true });
    // ③ 什么都没 ⇒ 红（就是 2026-10-10 那个死路的形状）
    d = build({ "MobileGamma.tsx": "export function MobileGamma(){ return <div/>; }" });
    const r3 = scan(d);
    cases.push(["一个路都没有 ⇒ 被点名", r3.missing.length === 1 && r3.missing[0] === "MobileGamma"]);
    rmSync(d, { recursive: true, force: true });
    // ④ 卡片/导航条/首页本身 ⇒ 不算屏
    d = build({
      "MobileHome.tsx": "export function MobileHome(){ return <div/>; }",
      "MobileDictCard.tsx": "export function MobileDictCard(){ return <div/>; }",
    });
    cases.push(["首页本身与卡片不算屏", scan(d).screenCount === 0]);
    rmSync(d, { recursive: true, force: true });
    // ⑤ 没有 src/components ⇒ 环境不具备（不是"通过"）
    d = mkdtempSync(join(tmpdir(), "mor-exit-empty-"));
    cases.push(["没有 src/components ⇒ 环境不具备", Boolean(scan(d).envMissing)]);
    rmSync(d, { recursive: true, force: true });
  } catch (e) {
    console.error("自测异常：" + e.message);
    return 1;
  }
  let bad = 0;
  for (const [name, okv] of cases) {
    console.log(`  ${okv ? "✓" : "✗"} ${name}`);
    if (!okv) bad++;
  }
  console.log(`\nself-test：${cases.length - bad}/${cases.length}`);
  return bad === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  process.exit(selfTest());
}
const di = args.indexOf("--dir");
const root = di > -1 ? resolve(args[di + 1]) : resolve(import.meta.dirname, "..");
process.exit(run(root));
