// 门禁：**移动屏不许借桌面布局类**（阶段 1 的棘轮，R203 ⇒ owner 拍「单立，走乙丙」）。
//
// ## 它挡的是哪一次真事故（`incident`，⛔ 不是装饰 ✗）
// 移动屏**直接借桌面布局类**（最典型：7 屏全都写成 `<div className="main mpair">` 这类 ✓）
// ⇒ 于是**桌面侧每加一个状态类，移动屏被顺带动一下** ✗ —— 实测活证据：`src/App.css`
// 里 `.main` 有 **11 处**规则命中 ✓，其中 `body.is-toc-open .main`（`:4715`）／
// `body.is-ai-open .main`（`:4722`）／`body.is-plugin-panel-open .main`（`:21341`／`:21661`）
// 全是**桌面侧的状态** ✓ ⇒ 移动屏借它，就跟着这些状态一起动 ✓（这正是 owner 要"单立"的动因之一 ✓）。
//
// ## 判据（纯静态源码扫描 ⇒ **确定** ✓，⛔ 不依赖浏览器/平台 ✗）
// 扫 `src/components/Mobile*.tsx`（⛔ 排除 `*.test.tsx` ✗）＋ `src/App.tsx` 里**与 `isMobile`
// 同一行**出现的 className ✓ ⇒ 每个记号必须 ∈ { 移动命名空间 ＋ **显式共享白名单** } ⇒
// **名单外出现 ⇒ 红** ✓。
//
// ## ⛔ 三条不许破
// ① ⛔ **不许**写成"className 必须以 `m` 开头" ✗ —— 那会把 `.main` 一起判死 ✓，
//    也会误伤将来**合理**的共享状态类（`.is-primary` ✓）⇒ 白名单就是为它们存在的 ✓。
// ② ⭐ 白名单是**显式清单 ＋ 长度常量** ✓（`SHARED.length` 必须等于 `SHARED_EXPECTED` ✓）
//    ⇒ 往清单里加一行**必须同时改常量** ✓ ⇒ **悄悄加不了** ✗（加行是显式动作 ✓，机器拦不住动机、
//    但拦得住"没人看见就绿了" ✓）。⭐ 这就是**棘轮**：长度**只减不增** ✓。
// ③ ⛔ **本笔只加门禁** ✗ —— 一个移动组件都不改 ✓、桌面 `.main` 一个字节都不动 ✓。
//
// ## 为什么**不另立基线文件**
// 它**只在"新借用"时红** ✓（静态扫描、确定 ✓）⇒ 不需要计数类基线 ✓；白名单＋长度常量就是棘轮 ✓。
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 不算通过（扫面为空 —— 路径改了或文件没了）
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = join(REPO_ROOT, "src", "components");
const APP_TSX = join(REPO_ROOT, "src", "App.tsx");

/**
 * ⭐ **显式共享白名单**（棘轮：长度只减不增 ✓）。
 * 每条都写**为什么它现在是共享的** ✓ —— 阶段 1 的目标是**一格一格划掉它** ✓，
 * 每划掉一格都要有读数 ✓（这张表本身就是**阶段 1 的进度表** ✓）。
 */
const SHARED = [
  // 状态修饰类（改配色/强调 ✓，⛔ 不是布局 ✗）：将来要不要给移动自己的状态命名，是阶段 1 的取舍 ✓。
  "is-accent",
  "is-on",
  "is-pending",
  "is-primary",
  "is-strong",
  // `TopTools` 的**移动变体**（`App.tsx:1120` `className={isMobile ? "is-mobile" : "is-web"}` ✓）
  // —— 同一组件的两种皮肤，⛔ 不是"移动借桌面布局" ✗ ⇒ 显式收着 ✓。
  "is-mobile",
];

/** ⭐ 白名单**长度常量** —— 加行必改它 ✓（棘轮的那一半 ✓）。 */
const SHARED_EXPECTED = 6;

/** 移动命名空间（照各屏的 `.m*` 族 ✓；`mset*` 是设置屏自己的族 ✓；`mtab*` 是底边栏自己的族 ✓）。 */
const MOBILE_NS = /^m(home|cap|search|read|dict|pair|about|set|settings|note|merge|rail|sync|scroll|pop|sheet|bar|btn|icon|card|head|body|foot|line|list|item|chip|grid|meta|src|dim|empty|title|when|who|count|undo|mark|back|close|actions|hint|err|send|save|draft|tool|filter|result|thumb|dot|time|tag|badge|kbd|seg|toggle|nav|feed|sub|avatar|state|status|row|col|wrap|stack|cover|preview|quote|code|table|tree|pane|overlay|layer|drawer|shell|top|mid|bot|tab)(-|$)/;

/** 取一段源码里的 className 记号（含模板串 `className={`…`}` ✓）。 */
function classTokens(src) {
  const out = [];
  for (const m of src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const tok of (m[1] ?? m[2] ?? "").split(/\s+/)) {
      if (tok && !tok.includes("{") && !tok.startsWith("$")) out.push(tok);
    }
  }
  return out;
}

const findings = [];
let scanned = 0;

// ① 移动屏组件（⛔ 排除测试文件 ✗）
for (const name of readdirSync(COMPONENTS)) {
  if (!/^Mobile.*\.tsx$/.test(name) || /\.test\.tsx$/.test(name)) continue;
  scanned++;
  const file = join(COMPONENTS, name);
  for (const tok of classTokens(readFileSync(file, "utf8"))) {
    if (SHARED.includes(tok) || MOBILE_NS.test(tok)) continue;
    findings.push({ where: `src/components/${name}`, tok });
  }
}

// ② `App.tsx` 里**与 `isMobile` 同一行**出现的 className（移动分支里最常见的内联写法 ✓）
{
  const src = readFileSync(APP_TSX, "utf8");
  src.split("\n").forEach((line, i) => {
    if (!line.includes("isMobile")) return;
    for (const tok of classTokens(line)) {
      if (SHARED.includes(tok) || MOBILE_NS.test(tok)) continue;
      findings.push({ where: `src/App.tsx:${i + 1}`, tok });
    }
  });
}

// ⚠️ 扫面必须非空 —— 否则"路径改了"会被读成"干净" ✗（不算通过 ✓）
if (scanned === 0) {
  console.error("❌ 不算通过：一个 `Mobile*.tsx` 都没扫到（路径改了？）—— 这不是干净 ✗");
  process.exit(2);
}

// ⭐ 棘轮的那一半：长度常量必须与清单一致 ⇒ 加行必改常量 ⇒ 悄悄加不了 ✓
if (SHARED.length !== SHARED_EXPECTED) {
  console.error(
    `❌ 白名单长度 ${SHARED.length} ≠ 常量 ${SHARED_EXPECTED} —— 往清单加行必须同时改常量（棘轮 ✓，⛔ 不许悄悄加 ✗）`,
  );
  process.exit(1);
}

if (findings.length) {
  console.error("❌ 不算通过：移动屏借了**非移动命名空间**的类（⛔ 不是布局共享 ✗）：");
  for (const f of findings) console.error(`   ${f.where}  ⇒  .${f.tok}`);
  console.error(
    `\n   ${findings.length} 处。要么改成移动自己的类（阶段 1），要么**显式**加进 SHARED（并同时改 SHARED_EXPECTED ＋ 写明理由）✓`,
  );
  process.exit(1);
}

console.log(
  `✓ 干净：扫了 ${scanned} 个移动组件 ＋ App.tsx 的 isMobile 行；` +
    `共享白名单 ${SHARED.length} 条（棘轮 ✓，只减不增）；名单外 0 处 ✓`,
);
