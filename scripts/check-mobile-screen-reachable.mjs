// 门禁：**手机上不许有死屏**（阶段 2 的第一刀，R203 owner 拍「单立，走乙丙」）。
//
// ## 它挡的是哪一次真事故（`incident`，⛔ 不是装饰 ✗）
// 2026-10-14 侦察实测（台账 **R205** ✓）：`MobileSettings` 是**死屏** ✗ —— 屏在 ✓、**门没有** ✗
// （全 `src/` grep 排除它自己后**零命中** ✓，且 `MobileScreen` 那个联合类型里**没有 `settings`** ✓）
// ⇒ **用户到不了它** ✓。而它是**人读出来的** ✗（没有任何机器挡着 ✓）⇒ 本条把它变成机器判据 ✓。
// ⚠️ 同一轮还量到 `MobileAbout` **不是**死屏 ✓（`src/store/editor.ts:83` 有 `openAbout` ✓、
// `App.tsx:1206` 有渲染 ✓），⭐ **但手机上同样点不到它** ✗（它沿用 `aboutOpen` ⇒ 走**桌面 chrome** 那条路 ✓）
// ⇒ 这两种"到不了"必须**明写**出来 ✓（见下面 `reachable` 字段 ✓），⛔ 不许含糊成"大概能到" ✗。
//
// ## 判据（纯静态源码扫描 ⇒ **确定** ✓，⛔ 不依赖浏览器/平台 ✗）
// ① **屏清单** ✓：盘上每个"移动屏"文件（`src/components/Mobile*.tsx`，⛔ 排除 `*.test.tsx` ✗）
//    必须在下面 **`SCREENS` 显式登记表**里 ✓ ⇒ **新加一屏没登记 ⇒ 红** ✓；
// ② **入口证据** ✓：登记项写**到达方式** `reach`（`nav` 屏栈 ／ `currentId` 轴 ／ `not-a-screen` 卡片或原型 ✓）
//    ⇒ 对 **`reach: "nav"` 且 `reachable: true`** 的那些，全仓必须存在 **≥1 处 `setScreen("<id>")`** ✓
//    ⇒ ⭐ **把入口删掉 ⇒ 红** ✓（"门"是核得到的 ✓）；
// ③ **`reachable` 必须是布尔** ✓（`true`/`false`）＋ 每项必须写非空 `why` ✓
//    ⇒ ⛔ **中间态不许含糊** ✗（"到不了"必须**明写** ✓，这样它不会被当成"已做"✓）；
// ④ **只增不减** ✓：`SCREENS.length` 必须等于 `SCREENS_EXPECTED` ✓（照命名空间那条门禁的棘轮写法 ✓）。
//
// ## 为什么**不写成"扫 `Mobile*.tsx` 就要求它都在屏栈里"** ✗
// 三种正当例外（实测 ✓）：`MobileDictCard` 是**卡片**不是屏 ✓；`MobileMergeHistory` 是**未接线原型** ✓；
// `MobileRead` **不在 `mobileScreen` 轴上** ✓（它由 `App.tsx` 的 `isCurrentId` 那一支决定 ✓）
// ⇒ 登记表用 `reach` 表达这三种情形 ✓（这也是它比"名字前缀"判据强的地方 ✓）。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 不算通过（扫面为空 ⇒ 不是干净 ✗）
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = join(REPO_ROOT, "src", "components");
const SRC = join(REPO_ROOT, "src");

/**
 * ⭐ **显式登记表**（棘轮：长度只增不减 ✓ —— 见 `SCREENS_EXPECTED` ✓）。
 *
 * `reach`：`nav`＝走 `useMobileNav` 屏栈 ✓／`currentId`＝由"有没有打开页"决定 ✓／`not-a-screen`＝卡片或未接线原型 ✓。
 * `reachable`：⭐ **现刻能不能到达** ✓ —— ⛔ 必须布尔、不许含糊 ✗；`false` 就是**如实记着"到不了"** ✓
 *   （它同时是**阶段 2 的待办清单**：`settings` 与 `about` 两项 ✓）。
 */
const SCREENS = [
  { file: "MobileHome.tsx", id: "home", testid: "mobile-home", reach: "nav", reachable: true, why: "首页；入口＝App 启动即此档（`mobileNav.screen` 初值 `home` ✓）" },
  { file: "MobileCapture.tsx", id: "capture", testid: "mobile-capture", reach: "nav", reachable: true, why: "首页那张「快速记录」卡调 `setScreen(\"capture\")` ✓" },
  { file: "MobileSearch.tsx", id: "search", testid: "mobile-search", reach: "nav", reachable: true, why: "首页那张「搜索」卡调 `setScreen(\"search\")` ✓" },
  { file: "MobilePair.tsx", id: "pair", testid: "mobile-pair", reach: "nav", reachable: true, why: "手机档常驻「同步」胶囊（`SyncPanel`）调 `setScreen(\"pair\")` ✓" },
  { file: "MobileRead.tsx", id: "read", testid: "mobile-read", reach: "currentId", reachable: true, why: "⭐ **不在 `mobileScreen` 轴上** ✓：由 `App.tsx` 的 `isMobile && currentId` 那一支决定 ✓（打开任一页即达 ✓）" },
  { file: "MobileAbout.tsx", id: "about", testid: "mobile-about", reach: "flag", flag: "openAbout", reachable: true, why: "⭐ **阶段 2 已建成** ✓（2026-10-14）：手机上从**移动设置屏**的「关于与更新」行进 ✓（它调既有的 `aboutOpen` ✓）⇒ 它走的是**旗标轴**（`App.tsx` 的 `isMobile && aboutOpen` ✓），⛔ 不是屏栈轴 ✗" },
  { file: "MobileSettings.tsx", id: "settings", testid: "mobile-settings", reach: "nav", reachable: true, why: "⭐ **阶段 2 已建成** ✓（2026-10-14）：手机 ⚙️（`ActivityBar` 的 `.activity-btn`）在**手机形态**下走 `setScreen(\"settings\")` ✓（桌面仍是原 `SettingsDialog` ✓）" },
  { file: "MobileMergeHistory.tsx", id: "merge-history", testid: "mobile-merge-history", reach: "not-a-screen", reachable: false, why: "未接线**原型** ✓（`0e79ae91` ✓）：**故意不接进任何用户可见路径** ✓ ⇒ 不是屏、也不是死屏 ✓" },
  { file: "MobileDictCard.tsx", id: null, testid: null, reach: "not-a-screen", reachable: false, why: "**卡片**不是屏 ✓（划词卡，锚在 `.mread` 里 ✓）" },
  { file: "MobilePairCode.tsx", id: "paircode", testid: "mobile-paircode", reach: "nav", reachable: true, why: "⭐ d1（2026-10-17 owner 拍「甲」）新建 ✓：从「设备直连」的两颗入口（接入／重新配对 ⇒ `setScreen(「paircode」)` ✓）进来 ✓；⚠️ 20 格对码**本轮未接** ✗（下一刀 d2 ✓），屏上明标未接 ✓" },
];

/** ⭐ 长度常量（棘轮 ✓）：加一屏必须同时改它 ⇒ **悄悄加不了** ✗。 */
const SCREENS_EXPECTED = 10;

const findings = [];
const files = readdirSync(COMPONENTS).filter((n) => /^Mobile.*\.tsx$/.test(n) && !/\.test\.tsx$/.test(n));

// ⓪ 扫面非空（否则"路径改了"会被读成干净 ✗）
if (files.length === 0) {
  console.error("❌ 不算通过：一个 `Mobile*.tsx` 都没扫到（路径改了？）—— 这不是干净 ✗");
  process.exit(2);
}

// ④ 棘轮
if (SCREENS.length !== SCREENS_EXPECTED) {
  console.error(`❌ 登记表长度 ${SCREENS.length} ≠ 常量 ${SCREENS_EXPECTED} —— 加屏必须同时改常量（棘轮 ✓，⛔ 不许悄悄加 ✗）`);
  process.exit(1);
}

// ① 每个盘上的屏文件都必须在登记表里
const registered = new Set(SCREENS.map((s) => s.file));
for (const f of files) if (!registered.has(f)) findings.push(`${f} 是移动屏文件，但**没有登记**在 SCREENS 里（新屏 ⇒ 必须显式登记它的 reach 与 reachable ✓）`);

// ②③ 逐项核
const srcText = (function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = join(dir, n);
    if (statIsDir(p)) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(readFileSync(p, "utf8"));
  }
  return out.join("\n");
})(SRC);
function statIsDir(p) {
  try {
    return readdirSync(p) !== undefined;
  } catch {
    return false;
  }
}

for (const s of SCREENS) {
  if (typeof s.reachable !== "boolean") findings.push(`${s.file}：\`reachable\` 必须是布尔（⛔ 中间态不许含糊 ✗）`);
  if (!s.why || s.why.trim().length < 8) findings.push(`${s.file}：\`why\` 必须写清（≥8 字符）—— 它就是这个屏的"为什么这样登记" ✓`);
  if (!files.includes(s.file)) findings.push(`${s.file}：登记了但盘上没有这个文件（改名/删了？⇒ 登记表要跟着改 ✓）`);
  if (s.testid && !readFileSync(join(COMPONENTS, s.file), "utf8").includes(`data-testid="${s.testid}"`)) {
    findings.push(`${s.file}：屏根里找不到 \`data-testid="${s.testid}"\`（改掉 testid ⇒ 屏清单对不上 ✓）`);
  }
  if (s.reach === "flag" && s.reachable === true) {
    if (!new RegExp(`${s.flag}\\(\\)`).test(srcText)) findings.push(`${s.file}：登记成"可到达（flag=${s.flag}）"⇒ 全仓必须存在 ${s.flag}() 的**入口调用**，实际 0 处 ✓`);
  }
  if (s.reach === "nav" && s.reachable === true) {
    const calls = new RegExp(`setScreen\\("${s.id}"\\)`, "g");
    if (!calls.test(srcText)) findings.push(`${s.file}：登记成"可到达（nav）"⇒ 全仓必须存在 \`setScreen("${s.id}")\` 的**入口调用**，实际 **0 处** ⇒ 门被删掉/没建 ✓`);
  }
}
// `nav` 且**不可达**的：必须确实没有入口（否则登记说谎 ✗）
for (const s of SCREENS) {
  if (s.reach === "nav" && s.reachable === false) {
    if (new RegExp(`setScreen\\("${s.id}"\\)`).test(srcText)) findings.push(`${s.file}：登记成"到不了"但仓里**已经有** \`setScreen("${s.id}")\` ⇒ 登记说谎（要么改 reachable、要么删掉那处 ✓）`);
  }
}

if (findings.length) {
  console.error("❌ 不算通过：移动屏的可达性对不上（⛔ 不许有死屏 ✗）：");
  for (const f of findings) console.error(`   ${f}`);
  process.exit(1);
}

const reachable = SCREENS.filter((s) => s.reachable).length;
const pending = SCREENS.filter((s) => s.reach === "nav" && !s.reachable).map((s) => s.id);
console.log(
  `✓ 干净：移动屏文件 ${files.length} 个全部登记 ✓；登记表 ${SCREENS.length} 条（棘轮 ✓）` +
    `；可达 ${reachable} 条 ✓；⭐ **如实记着"到不了"的 ${pending.length} 条：${pending.join("／")}** ✓（阶段 2 的待办 ✓）`,
);
