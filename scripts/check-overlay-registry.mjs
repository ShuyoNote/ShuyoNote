// 浮层登记门禁 · **枚举**仓库里"看起来是覆盖层"的组件，要求每一个要么真的登记进返回栈 +
// 移动端验收清单，要么在**显式的豁免清单**里写明理由。
//
// ## 为什么需要它（这道门禁是被一个真机 bug 逼出来的）
//
// 真机复验（2026-09-15）抓到第 6 个问题：**版本历史弹层没登记进浮层栈**——
// 只开着它时 `window.__SHUYONOTE_BACK__.depth()` = **0**，于是按 Android 返回键
// **直接退出应用**，而弹层还开着（实测见 `docs/MOBILE.md` §4.1.5）。
// 根因不是"写错了"，而是"**漏了**"：`src/lib/overlayStack.ts` 的登记是
// **每个浮层组件各写一行** `useOverlayLayer(...)`，漏一层不会有任何症状——
// 没有报错、没有单测变红、`verify-mobile-overlays.mjs` 里那份**手写的 19 项清单**
// 也照样全绿（它只检查清单里**已经写上**的那些层）。
// 换句话说：**清单和实现对不上时，缺的那一方永远不会自己暴露。**
//
// ## 判据（四层，逐条打印；任何一条红了即非零退出）
//
// A. **组件级 · 渲染容器的都要登记**：源码里渲染 `*-overlay` / `*-popover` 容器的组件，
//    必须调用 `useOverlayLayer("<id>", …)`。这是"漏登记"的正对判据：**新增浮层只要长得像浮层，
//    就必须做一次选择**——登记，或者**显式**写进 `EXEMPT_COMPONENTS` 并给出理由。
// B. **覆盖级 · 登记了的都要被验**：每个登记过返回栈的 id，它所在组件渲染出的类名必须
//    出现在 `OVERLAYS` 的 `root`/`box` 里（= 移动端几何上真的量过它）；否则要写进
//    `EXEMPT_FROM_MOBILE_PASS` 说明为什么"已登记但未纳入几何验收"——那是**未验证项**，不是"验过了"。
//    ⚠️ 这里刻意**不比对 id 字符串**：`OVERLAYS` 的 id 同时是 `openOverlay()` 的 switch 键，
//    与返回栈 id 历史上并不总同名（`formula` vs `formulaEditor` …）。id 只是诊断用的名字，
//    **能对上的是"这一层真的被量了"这个事实**，判据就用渲染出来的类名。
// C. **反向 · 清单里不许有幽灵条目**：`OVERLAYS` 每一层的 `root`/`box` 类名都要有组件真的渲染它，
//    而且**其中至少一个组件登记了返回栈**。否则就是"清单里列着、没人登记、也没人真的关它"。
//    这一条同时挡住"类名被改名"：`optional: true` 的层改名后会**静默降级成一条 note**
//    （既不算通过也不算失败），于是"验过了"其实一次都没量到。
// D. **豁免清单本身不许过期**：写了豁免、但那个组件已经不存在了 ⇒ 红（否则豁免清单会慢慢烂掉）。
//
// ## 候选是怎么认出来的（**窄而保守**：宁可少报，不许错报一堆）
//
// 只认一件事：**JSX 里字面量写出来的、以 `-overlay` / `-popover` 结尾的 class token**
// （`className="stg-overlay"`、模板串 `` className={`sync-popover is-sync${…}`} `` 都算）。
// 刻意**不**做"文件名含 Dialog/Panel/Picker"这类模糊匹配——那会把
// `AttachmentPanel` / `PropertiesPanel` / `PluginIndexPanel` 这些**内联面板**全拉进来，
// 豁免清单会被噪声淹掉，门禁随之失去意义。宁可少报几个（少的那些由 B / C 兜），
// 也不要错报一堆。
//
// ## 怎么加一层（新增浮层时）
//
// 1. 组件里写 `useOverlayLayer("<id>", open, close)`（见 `src/hooks/useOverlayLayer.ts`）；
// 2. 在 `scripts/verify-mobile-overlays.mjs` 的 `OVERLAYS` 里加一行，`root`/`box` 填它渲染的类名
//    （见 `docs/MOBILE.md` §4.1.4）；
// 3. 跑 `pnpm check:overlays`。
// 故意先跑一遍看它红，再按上面的步骤变绿——这道门禁的意义就是**先红**。
//
// 用法：node scripts/check-overlay-registry.mjs   （有不一致即非零退出）
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAYS_SCRIPT = join(root, "scripts", "verify-mobile-overlays.mjs");

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

// ---------------------------------------------------------------------------
// 读源码：每个 .tsx 渲染出来的 class token + 它登记的浮层 id
// ---------------------------------------------------------------------------

/**
 * JSX 里 `className` 的字面量部分。模板串与普通串**分开取**：
 * 用一条 `[^`"]*` 通吃会在第一个 `"` 上截断，于是
 * `` className={`trash-popover${isSheet ? " is-sheet" : ""}`} `` 只截到 `trash-popover${isSheet ? `
 * ——`-popover` 因为后面还挂着 `${` 就**认不出来**了（实测漏掉 `.search-popover` / `.trash-popover`
 * 两层，门禁反而把这两层报成"清单里的幽灵"）。所以模板串取到反引号、普通串取到引号。
 */
const CLASSNAME_TEMPLATE = /className=\{?`([^`]*)`\}?/g;
const CLASSNAME_PLAIN = /className="([^"]*)"/g;
/** 模板串里的 `${…}` 表达式：只在**取 class token** 时挖掉（`${isSheet ? " is-sheet" : ""}`）。 */
const TEMPLATE_EXPR = /\$\{[^{}]*\}/g;
/** 一个 class token 是不是浮层容器：以 `-overlay` / `-popover` 结尾。 */
const CONTAINER_TOKEN = /(^|-)(overlay|popover)$/;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) acc.push(p);
  }
  return acc;
}

/**
 * `index` 这个位置是不是落在**注释**里？
 *
 * 为什么必须有：自测实测到的盲区——把 `useOverlayLayer("history", …)` 整行注释掉之后，
 * 本门禁**仍然绿**（正则连注释里的那行也算成了登记），而它恰恰要挡的就是"看起来登记了、
 * 其实没登记"。注释掉的登记不算登记，注释掉的 JSX 也不算渲染了容器。
 */
function inComment(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEndRaw = text.indexOf("\n", index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  // 行内的 `//`：只有在**不在引号里**时才算注释开始（`"https://x"` 不算）。
  const before = line.slice(0, index - lineStart);
  const slashes = before.indexOf("//");
  if (slashes >= 0) {
    const quotes = (before.slice(0, slashes).match(/(^|[^\\])["'`]/g) || []).length;
    if (quotes % 2 === 0) return true;
  }
  // 块注释：往前看最近的 `/*` 与 `*/` 谁更靠后。
  const open = text.lastIndexOf("/*", index);
  return open >= 0 && open > text.lastIndexOf("*/", index);
}

/** 源码里渲染出来的 class token（注释里的不算）。 */
function scanClassTokens(text) {
  const tokens = new Set();
  for (const re of [CLASSNAME_TEMPLATE, CLASSNAME_PLAIN]) {
    for (const m of text.matchAll(re)) {
      if (inComment(text, m.index)) continue;
      for (const token of m[1].replace(TEMPLATE_EXPR, " ").split(/\s+/)) {
        if (token && !token.includes("$")) tokens.add(token);
      }
    }
  }
  return [...tokens];
}

/** 源码里登记的浮层 id（`useOverlayLayer("id", …)`；注释里的不算）。 */
function scanRegisteredIds(text) {
  return [...text.matchAll(/useOverlayLayer\(\s*"([^"]+)"/g)]
    .filter((m) => !inComment(text, m.index))
    .map((m) => m[1]);
}

const sources = walk(join(root, "src")).map((file) => {
  const text = readFileSync(file, "utf8");
  const tokens = scanClassTokens(text);
  return {
    rel: relative(root, file).replace(/\\/g, "/"),
    tokens,
    containers: tokens.filter((t) => CONTAINER_TOKEN.test(t)),
    ids: scanRegisteredIds(text),
  };
});

// `OVERLAYS` 清单（**解析**移动端验收脚本，不在这里抄一遍：抄一遍就又成了两份手写清单）
const overlaysText = readFileSync(OVERLAYS_SCRIPT, "utf8");
const overlaysStart = overlaysText.indexOf("const OVERLAYS = [");
const overlaysEnd = overlaysText.indexOf("\n];", overlaysStart);
if (overlaysStart < 0 || overlaysEnd < 0) {
  console.error("解析不到 scripts/verify-mobile-overlays.mjs 里的 OVERLAYS 数组——先修本脚本的解析。");
  process.exit(1);
}
const overlays = [...overlaysText.slice(overlaysStart, overlaysEnd).matchAll(/\{[^{}]*\}/g)].map((m) => {
  const entry = m[0];
  const get = (k) => (entry.match(new RegExp(`${k}:\\s*"([^"]+)"`)) || [])[1] || null;
  const cls = (sel) => String(sel || "").replace(/^\./, "").trim();
  return {
    id: get("id"),
    label: get("label"),
    root: cls(get("root")),
    box: cls(get("box")),
    optional: /optional:\s*true/.test(entry),
  };
});
if (!overlays.length) {
  console.error("OVERLAYS 解析出 0 层——解析器写错了？先修本脚本。");
  process.exit(1);
}
/** `OVERLAYS` 里出现过的所有类名（root + box）。 */
const measuredClasses = new Set(overlays.flatMap((o) => [o.root, o.box]).filter(Boolean));

// ---------------------------------------------------------------------------
// 豁免清单（**显式**，每条都要有理由；`gap` = "同类缺口、本轮未修"，每次运行都会 ⚠️ 打印）
// ---------------------------------------------------------------------------
const EXEMPT_COMPONENTS = new Map([
  // ── 宿主已经是浮层的**子浮层**：返回键会先关掉宿主那一层 ──────────────────────
  ["src/components/AiSettingsDialog.tsx", { kind: "nested", reason: "AI 面板（已登记 `ai`）里的子对话框，由宿主的本地 state 开关" }],
  ["src/components/CoverCrop.tsx", { kind: "nested", reason: "题头图选择器（已登记 `coverPicker`）里的裁图步骤，由宿主状态开关" }],
  ["src/components/FormulaHandwritePad.tsx", { kind: "nested", reason: "公式编辑器（已登记 `formulaEditor`）里的手写板，由宿主状态开关" }],
  // ── 视图 / 编辑器内部的浮层：宿主自己不是浮层 ────────────────────────────────
  ["src/components/FileManagerView.tsx", { kind: "inline", reason: "「文件」视图内部的浮层（`.fm-version-overlay` / `.fm-move-popover`）：视图本身不是浮层" }],
  ["src/components/PdfAnnotationCanvas.tsx", { kind: "inline", reason: "PDF 批注画布内部的 OCR 结果浮层，跟着画布/阅读器走" }],
  ["src/components/EmailPanel.tsx", { kind: "inline", reason: "邮件面板是侧栏里的常驻内容（`PageTree` 里渲染）而非浮层；`.email-ai-modal-overlay` 是它内部的 AI 摘要弹层" }],
  ["src/editor/plugins/BlockInsertPlugin.tsx", { kind: "inline", reason: "编辑器内联浮层（块插入菜单），由编辑器插件自己的 state 管，随编辑器卸载" }],
  ["src/editor/plugins/BlockSelectorPlugin.tsx", { kind: "inline", reason: "编辑器内联浮层（块选择器），同上" }],
  ["src/editor/plugins/LinkPopoverPlugin.tsx", { kind: "inline", reason: "编辑器内联浮层（链接编辑气泡），同上" }],
  // ── 不是"可关闭浮层" ──────────────────────────────────────────────────────
  ["src/components/SpaceTransferProgress.tsx", { kind: "not-a-layer", reason: "全局导出/导入进度条：没有关闭动作（不吃点击、不吃 Esc）" }],
  // ── ⚠️ `gap` 级别的"同类缺口"目前**已经清零**（2026-09-15 第二轮） ─────────────
  // 上一轮留下的三处（`PdfReader` 浮层形态 / `PluginViewOverlay` / `FilePreviewDialog`）
  // 各接了一条 `useOverlayLayer`，因此不再是 `A` 判据下的"未登记"；它们转由 `B` 判据接管
  // （已登记、但还没纳入移动端几何验收 ⇒ 见下面的 `EXEMPT_FROM_MOBILE_PASS`）。
  // `gap` 这个类别仍然保留：下一次再发现"真的是应用级浮层却没登记"就先记在这里，
  // 每次运行 ⚠️ 打印出来，而不是让它悄悄烂在豁免表里。
]);

/** 已登记返回栈、但**不在**移动端几何验收清单里的 id（属"未验证项"）。 */
const EXEMPT_FROM_MOBILE_PASS = new Map([
  [
    "backupMenu",
    {
      reason:
        "锚在侧栏备份按钮上的下拉菜单（`usePopover` 已管定位与窄屏 is-sheet）；整屏几何验收里没有它 —— 属未验证项",
    },
  ],
  // ── 本轮新登记的三层：返回栈这一半修好了（A 判据过），但**几何验收还没纳入** ──────
  // 它们都需要"真实的文件/插件视图"才能打开，`verify-mobile-overlays.mjs` 在全新实例里
  // 取不到触发器；硬塞一个假对象进去只会把"四边在视口内 / 外壳被锁"这些断言变成假红。
  // 所以如实记成**未验证项**，而不是假装验过。
  [
    "pdfReader",
    {
      reason:
        "PDF 阅读器的**浮层形态**（窄屏 / 单页独立窗口；`inline` 模式是内容区视图、**不**登记）：" +
        "打开它需要一份真实 PDF（`usePdfReader.openPdf` 要读字节），验收脚本在全新实例里造不出来 —— 属未验证项",
    },
  ],
  [
    "pluginView",
    {
      reason:
        "插件声明式视图的整屏浮层（`placement` 为 `overlay` 时）：需要装一个带视图声明的插件才打得开，" +
        "验收脚本里没有这样的实例 —— 属未验证项",
    },
  ],
  [
    "filePreview",
    {
      reason:
        "应用级文件预览浮层（`useFilePreview` 驱动）：需要一份真实的附件（`target` 非空）才渲染，" +
        "验收脚本在全新实例里没有文件 —— 属未验证项",
    },
  ],
]);

// ---------------------------------------------------------------------------
// A. 组件级：渲染浮层容器的组件必须登记，或在豁免清单里
// ---------------------------------------------------------------------------
console.log("【A 渲染浮层容器的组件 → 必须登记进返回栈（或在豁免清单里）】");
const candidates = sources.filter((s) => s.containers.length > 0);
const unregistered = [];
for (const c of candidates) {
  if (c.ids.length) {
    console.log(`  ✓ ${c.rel}  [${c.containers.join(", ")}] → useOverlayLayer("${c.ids.join('", "')}")`);
    pass++;
  } else if (EXEMPT_COMPONENTS.has(c.rel)) {
    console.log(`  · ${c.rel}  [${c.containers.join(", ")}] → 豁免（${EXEMPT_COMPONENTS.get(c.rel).kind}）`);
  } else {
    unregistered.push(c);
  }
}
ok(
  unregistered.length === 0,
  unregistered.length === 0
    ? `枚举到 ${candidates.length} 个渲染浮层容器的组件，全部已登记或已豁免`
    : `${unregistered.length} 个组件渲染了浮层容器却既没登记也没豁免：` +
      unregistered.map((c) => `${c.rel}[${c.containers.join(", ")}]`).join(" / ") +
      `\n      ⇒ 加一行 useOverlayLayer("<id>", open, close)（见 src/hooks/useOverlayLayer.ts），` +
      `或写进本脚本的 EXEMPT_COMPONENTS 并给出理由`,
);

// ---------------------------------------------------------------------------
// B. 覆盖级：登记过返回栈的 id，其组件渲染的类名必须出现在 OVERLAYS 里
// ---------------------------------------------------------------------------
console.log("\n【B 已登记返回栈的层 → 必须在移动端 OVERLAYS 里被量到（或写明为何未纳入）】");
const notMeasured = [];
for (const s of sources) {
  for (const id of s.ids) {
    const hit = s.tokens.find((t) => measuredClasses.has(t));
    if (hit) console.log(`  ✓ ${id}（${s.rel}）← 由 OVERLAYS 的 .${hit} 量到`);
    else if (EXEMPT_FROM_MOBILE_PASS.has(id)) {
      console.log(`  · ${id}（${s.rel}）→ 未纳入几何验收：${EXEMPT_FROM_MOBILE_PASS.get(id).reason}`);
    } else notMeasured.push(`${id}（${s.rel}）`);
  }
}
ok(
  notMeasured.length === 0,
  notMeasured.length === 0
    ? `登记过返回栈的 ${sources.reduce((n, s) => n + s.ids.length, 0)} 条登记都能对上 OVERLAYS 里量到的一层`
    : `${notMeasured.length} 条登记在 OVERLAYS 里找不到对应的一层：${notMeasured.join(" / ")}` +
      `\n      ⇒ 去 scripts/verify-mobile-overlays.mjs 的 OVERLAYS 里加一行（root/box 填它渲染的类名），` +
      `或写进本脚本的 EXEMPT_FROM_MOBILE_PASS 说明它为什么不被量`,
);
ok(
  [...EXEMPT_FROM_MOBILE_PASS.keys()].every((id) => sources.some((s) => s.ids.includes(id))),
  "EXEMPT_FROM_MOBILE_PASS 里没有过期条目（每条都还对得上一条真实登记）",
);

// ---------------------------------------------------------------------------
// C. 反向：OVERLAYS 每一层的类名都要有组件真的渲染它，且其中至少一个登记了返回栈
// ---------------------------------------------------------------------------
console.log("\n【C OVERLAYS 的每一层 → 都要有组件真的渲染它、并且真的登记（清单不许有幽灵）】");
const ghostEntries = [];
const checkedClasses = new Set();
for (const o of overlays) {
  for (const cls of [o.root, o.box]) {
    if (!cls || checkedClasses.has(cls)) continue;
    checkedClasses.add(cls);
    const renderers = sources.filter((s) => s.tokens.includes(cls));
    if (!renderers.length) {
      ghostEntries.push(`${o.id}: .${cls} 没有任何组件渲染（类名改了？）`);
    } else if (!renderers.some((s) => s.ids.length)) {
      ghostEntries.push(`${o.id}: .${cls} 只被 ${renderers.map((r) => r.rel).join(", ")} 渲染，但没有一个登记返回栈`);
    }
  }
}
ok(
  ghostEntries.length === 0,
  ghostEntries.length === 0
    ? `OVERLAYS 的 ${overlays.length} 层（共 ${checkedClasses.size} 个不同类名）都真的有人渲染并登记`
    : `${ghostEntries.length} 条幽灵/失效条目：\n      - ${ghostEntries.join("\n      - ")}` +
      `\n      ⇒ 清单列着却没人登记 = 以为验过了；类名被改名时 optional:true 的层还会静默降级成一条 note`,
);

// ---------------------------------------------------------------------------
// D. 豁免清单不许过期
// ---------------------------------------------------------------------------
const staleExempt = [...EXEMPT_COMPONENTS.keys()].filter((rel) => !sources.some((s) => s.rel === rel));
ok(
  staleExempt.length === 0,
  staleExempt.length === 0
    ? "豁免清单没有过期条目（每条都还对得上一个组件）"
    : `豁免清单里有 ${staleExempt.length} 条已经对不上任何组件（删了/改名了？请一并删掉）：${staleExempt.join(", ")}`,
);

// ---------------------------------------------------------------------------
// 汇总：豁免清单每次都打印出来 —— 豁免是"显式的欠账"，不是藏东西的地方
// ---------------------------------------------------------------------------
console.log("\n【豁免清单（人工维护，但必须显式）】");
for (const [rel, ex] of EXEMPT_COMPONENTS) {
  console.log(`  ${ex.kind === "gap" ? "⚠️" : "  "} ${rel}  [${ex.kind}] ${ex.reason}`);
}
const gaps = [...EXEMPT_COMPONENTS.entries()].filter(([, ex]) => ex.kind === "gap");
if (gaps.length === 0) {
  console.log("\n  （`gap` 类别的同类缺口当前为 0：上一轮留下的三处已各接一条 useOverlayLayer，见 B 判据。）");
}
if (gaps.length) {
  console.log(`\n⚠️ 其中 ${gaps.length} 处是**同类缺口**（真的是应用级浮层，但没登记返回栈，本轮未修）：`);
  for (const [rel, ex] of gaps) console.log(`   · ${rel} —— ${ex.reason}`);
  console.log("   （它们不会让本门禁变红：门禁的契约是「新增浮层不许悄悄出现」。各接一条 useOverlayLayer 即可。）");
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error("浮层登记门禁未通过：有浮层没登记，或清单与实现已经对不上。");
  process.exit(1);
}
console.log("浮层登记门禁通过 ✅（枚举到的浮层容器全部已登记或有显式豁免）");
