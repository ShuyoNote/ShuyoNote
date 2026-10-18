#!/usr/bin/env node
// scripts/check-mcp-bundle-resources.mjs —— **安装包必须带上桥的所有相对 import**
//
// 为什么要有这条（2026-10-19 真实事故）：1.92.20 装完之后，连接器商店里那个 MCP 片段
// 在**任何**用户机器上都是 `ERR_MODULE_NOT_FOUND` ——
//   `tools/shuyonote-mcp/index.mjs` 在 10-18 改成 `import { resolveEndpointFiles } from "./paths.mjs"`，
//   而三份平台包配置（`src-tauri/tauri.{windows,macos,linux}.conf.json`）的 `bundle.resources`
//   **只映射了 index.mjs** ⇒ `paths.mjs` 从来没进过安装包。
//
// 这条为什么必须**独立**存在（不能靠 `check-mcp-bridge-stdout` 顺带 ✓）：
//   stdout 纯净、桥哑不哑、宿主面鉴权，三条判据都只看**源码**；而这次的破法是**源码全对、
//   少搬了一个文件** —— 打包漏文件是"仓库里一切正常、发出去必崩"的典型，只有把
//   「源码 import 图」与「三份 conf 的 resources」对起来才看得见 ✗。
//   ⚠️ 更狠的是它的**症状不可归因**：用户侧只看到 ERR_MODULE_NOT_FOUND（甚至只在 mcp 客户端日志里），
//   桥自己一行代码都没机会跑 ⇒ 没有任何日志、没有任何报错线索。
//
// 判据（纯读文件，不跑桥、不打包）：
//   ① 从 `tools/shuyonote-mcp/index.mjs` 出发，**递归**收集它（及它 import 到的本地模块）的相对 import；
//   ② 三份平台 conf **每一份**都必须把这些文件全部映射进 `mcp/`，且目标名 = `mcp/<源文件名>`；
//   ③ 递归里 import 到但**文件不存在** ⇒ 也是红（那说明 import 写错了，装出来同样崩）。
//   ⛔ 不做的事：不验 tgz/npm 那条路（`package.json` 的 `files` 由 npm 管）、不猜 Tauri 的资源语义。
//
// 登记形态（与 `check-mcp-bridge-dumb` 同形 ✓）：
//   桥不存在 ⇒ 绿 ＋ 自报跳过 ✓；要看那次红 ⇒ `--require-bridge` ⇒ exit 2（**不算通过** ✗）。
//
// 退出码：0 齐全 ／ 1 有漏 ／ 2 无对象或读不到（**不算通过**）
// 用法：node scripts/check-mcp-bundle-resources.mjs
//       ／ --bridge <index.mjs 路径> ／ --require-bridge ／ --root <仓库根> ／ --self-test
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 三份平台 conf —— **缺一份就判不了**（不许只核当前平台：漏的往往是另一台机器 ）。 */
export const CONF_FILES = [
  "src-tauri/tauri.windows.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "src-tauri/tauri.linux.conf.json",
];

/** resources 里桥的源前缀（conf 的 key 相对 `src-tauri/`，所以从那里往上跳一级）。 */
export const BRIDGE_RESOURCE_PREFIX = "../tools/shuyonote-mcp/";

/** 收相对 import：静态 `from "./x"` ／ 裸 `import "./x"` ／ 动态 `import("./x")`；绝对与裸包名不管。 */
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** 读一个源码文件里指向本地的 import（返回值已 `posix` 化，相对该文件所在目录）。 */
export function localImportsOf(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

/**
 * 纯判据：`files` ＝ Map<相对桥目录的 posix 路径, 源码文本>。
 * 返回 `{ needed:Set, findings:string[] }`；`findings` 里只放"import 图自身有问题"（文件缺失）。
 */
export function walkImports(entry, files) {
  const needed = new Set();
  const findings = [];
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const src = files.get(cur);
    if (src === undefined) {
      findings.push(
        `✗ \`${cur}\` 被 import 了，但**文件不存在** ⇒ 装出去一样崩（修 import 或补文件）`,
      );
      continue;
    }
    needed.add(cur);
    for (const raw of localImportsOf(src)) {
      // posix 归一：`./paths.mjs` → `paths.mjs`；`../x/y.mjs` 也照算（桥目录外的东西同样要进包）
      const next = posix.normalize(posix.join(posix.dirname(cur), raw));
      if (next.startsWith("../")) {
        findings.push(`✗ \`${cur}\` import 了桥目录之外的 \`${raw}\` ⇒ 那是另一个包的内容，桥不该依赖它`);
        continue;
      }
      if (!needed.has(next)) queue.push(next);
    }
  }
  return { needed, findings };
}

/** 从一份 conf 里取出"桥的哪些文件被搬进了 mcp/"，返回 Map<相对桥目录的 posix 路径, 目标路径>。 */
export function shippedFromConf(conf) {
  const resources = conf?.bundle?.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    return { ok: false, why: "`bundle.resources` 不是对象（解析不了就没法核 ⇒ 不许当通过）", shipped: new Map() };
  }
  const shipped = new Map();
  for (const [src, dest] of Object.entries(resources)) {
    const norm = String(src).replace(/\\/g, "/");
    if (!norm.startsWith(BRIDGE_RESOURCE_PREFIX)) continue;
    shipped.set(norm.slice(BRIDGE_RESOURCE_PREFIX.length), String(dest).replace(/\\/g, "/"));
  }
  return { ok: true, why: "", shipped };
}

/**
 * 纯判据：`needed`（桥要的全部文件）⇒ 每份 conf 的 findings。
 * `confs` ＝ [{ path, conf }]，三份都要在。
 */
export function judgeBundles(needed, confs) {
  const findings = [];
  for (const { path, conf } of confs) {
    const { ok, why, shipped } = shippedFromConf(conf);
    if (!ok) {
      findings.push(`✗ \`${path}\`：${why}`);
      continue;
    }
    for (const want of needed) {
      const dest = shipped.get(want);
      if (dest === undefined) {
        findings.push(
          `✗ \`${path}\` 的 \`bundle.resources\` **漏了** \`${BRIDGE_RESOURCE_PREFIX}${want}\` ⇒ ` +
            `装完桥 import 它会 ERR_MODULE_NOT_FOUND（2026-10-19 · 1.92.20 就是这个形状）`,
        );
        continue;
      }
      const wantDest = "mcp/" + basename(want);
      if (dest !== wantDest) {
        findings.push(
          `✗ \`${path}\` 把 \`${want}\` 搬到了 \`${dest}\`，而桥按同级相对路径 import ⇒ 必须是 \`${wantDest}\``,
        );
      }
    }
    // 反向：conf 搬了桥目录里"其实没被 import"的文件 ⇒ 不判红（多带一个文件不是事故）。
  }
  return findings;
}

/** 把桥目录读成 Map<相对 posix 路径, 源码文本>（只读判据要用的那几个：入口 ＋ 它 import 到的）。 */
function loadBridgeFiles(bridgeDir, entry) {
  const files = new Map();
  const seen = new Set();
  const queue = [entry];
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const abs = join(bridgeDir, cur.split("/").join(sep));
    if (!existsSync(abs)) continue; // 缺失留给 walkImports 报
    const src = readFileSync(abs, "utf8");
    files.set(cur, src);
    for (const raw of localImportsOf(src)) {
      const next = posix.normalize(posix.join(posix.dirname(cur), raw));
      if (!next.startsWith("../") && !seen.has(next)) queue.push(next);
    }
  }
  return files;
}

function run(root, bridgePath, requireBridge) {
  const confs = [];
  for (const rel of CONF_FILES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      console.error(`✗ 读不到 \`${rel}\` ⇒ 三份平台 conf 必须都在（只核当前平台会漏掉另一台机器的崩溃）`);
      return 2;
    }
    let conf;
    try {
      conf = JSON.parse(readFileSync(abs, "utf8"));
    } catch (e) {
      console.error(`✗ \`${rel}\` 不是合法 JSON（${e.message}）`);
      return 2;
    }
    confs.push({ path: rel, conf });
  }

  if (!existsSync(bridgePath)) {
    console.error("  ! 自报跳过（不装绿）：MCP 桥还不存在 ⇒ 本条判据现在没有可检查对象");
    if (requireBridge) {
      console.error("  ⇒ 已给 `--require-bridge` ⇒ 按「桥不存在 / 无可检查对象」exit 2（**不算通过** ✗）");
      return 2;
    }
    console.error("  ⇒ 登记形态：绿 ＋ 自报跳过（要看那次红就加 `--require-bridge`）");
    return 0;
  }

  const bridgeDir = dirname(bridgePath);
  const entry = basename(bridgePath);
  const files = loadBridgeFiles(bridgeDir, entry);
  const { needed, findings: importFindings } = walkImports(entry, files);
  const findings = [...importFindings, ...judgeBundles(needed, confs)];

  if (findings.length) {
    for (const x of findings) console.error(x);
    console.error(
      `\n  ⇒ 修法：在 \`src-tauri/tauri.{windows,macos,linux}.conf.json\` 的 \`bundle.resources\` 里` +
        `逐行补上 \`"${BRIDGE_RESOURCE_PREFIX}<文件>": "mcp/<文件>"\``,
    );
    return 1;
  }
  console.log(
    `✓ 安装包带全了桥的 import：${needed.size} 个文件（${[...needed].sort().join(" / ")}）` +
      ` × 3 份平台 conf 全部命中 ✓`,
  );
  return 0;
}

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const ROOT = argValue("--root") ? join(argValue("--root")) : dirname(HERE);

if (argv.includes("--self-test")) {
  // 用**假文件**跑纯判据（不碰真仓库），每条都是"这次真发生过"或"同族会再发生"的形状。
  const files = new Map([
    ["index.mjs", 'import { resolveEndpointFiles } from "./paths.mjs";\nimport "./side.mjs";\n'],
    ["paths.mjs", 'import { join } from "node:path";\nimport { helper } from "./helper.mjs";\n'],
    ["helper.mjs", "export const helper = 1;\n"],
    ["side.mjs", "export const side = 1;\n"],
  ]);
  const { needed, findings: importFindings } = walkImports("index.mjs", files);

  const conf = (mapping) => ({ path: "conf", conf: { bundle: { resources: mapping } } });
  const full = (extra = {}) => conf({
    "../tools/shuyonote-mcp/index.mjs": "mcp/index.mjs",
    "../tools/shuyonote-mcp/paths.mjs": "mcp/paths.mjs",
    "../tools/shuyonote-mcp/helper.mjs": "mcp/helper.mjs",
    "../tools/shuyonote-mcp/side.mjs": "mcp/side.mjs",
    ...extra,
  });

  const cases = [
    ["正例（import 图齐全，含传递 import）", () => judgeBundles(needed, [full()]), 0],
    [
      "变异①（1.92.20 原形：漏了 paths.mjs）",
      () => judgeBundles(needed, [conf({
        "../tools/shuyonote-mcp/index.mjs": "mcp/index.mjs",
        "../tools/shuyonote-mcp/helper.mjs": "mcp/helper.mjs",
        "../tools/shuyonote-mcp/side.mjs": "mcp/side.mjs",
      })]),
      1,
    ],
    [
      "变异②（传递依赖漏了 helper.mjs —— 只看入口 import 会漏掉这层）",
      () => judgeBundles(needed, [conf({
        "../tools/shuyonote-mcp/index.mjs": "mcp/index.mjs",
        "../tools/shuyonote-mcp/paths.mjs": "mcp/paths.mjs",
        "../tools/shuyonote-mcp/side.mjs": "mcp/side.mjs",
      })]),
      1,
    ],
    [
      "变异③（搬了但改名成 mcp/sub/paths.mjs ⇒ 同级 import 找不到）",
      () => judgeBundles(needed, [conf({
        "../tools/shuyonote-mcp/index.mjs": "mcp/index.mjs",
        "../tools/shuyonote-mcp/paths.mjs": "mcp/sub/paths.mjs",
        "../tools/shuyonote-mcp/helper.mjs": "mcp/helper.mjs",
        "../tools/shuyonote-mcp/side.mjs": "mcp/side.mjs",
      })]),
      1,
    ],
    [
      "变异④（import 了不存在的文件）",
      () => walkImports("index.mjs", new Map([["index.mjs", 'import "./ghost.mjs";\n']])).findings,
      1,
    ],
    [
      "变异⑤（resources 写成了数组 ⇒ 解析不了，不许当通过）",
      () => judgeBundles(needed, [{ path: "conf", conf: { bundle: { resources: ["a"] } } }]),
      1,
    ],
  ];

  let pass = importFindings.length === 0 ? 1 : 0;
  console.log(`  ${pass ? "✓" : "✗"} 正例的 import 图本身没有缺失（期望 0 条）`);
  for (const [name, fn, want] of cases) {
    const got = fn();
    const n = Array.isArray(got) ? got.length : got;
    const okc = n === want;
    if (okc) pass++;
    console.log(`  ${okc ? "✓" : "✗"} ${name} ⇒ findings=${n}（期望 ${want}）` + (Array.isArray(got) && got[0] ? " ｜ " + String(got[0]).slice(0, 90) : ""));
  }

  // 空扫：桥不在 ⇒ 登记形态 0；加 --require-bridge ⇒ 2 ✓
  const a = run(ROOT, join(ROOT, "tools", "shuyonote-mcp", "__nope__.mjs"), false);
  const b = run(ROOT, join(ROOT, "tools", "shuyonote-mcp", "__nope__.mjs"), true);
  const okA = a === 0, okB = b === 2;
  if (okA) pass++;
  if (okB) pass++;
  console.log(`  ${okA ? "✓" : "✗"} 空扫（登记形态）⇒ exit=${a}（期望 0）`);
  console.log(`  ${okB ? "✓" : "✗"} 空扫 ＋ \`--require-bridge\` ⇒ exit=${b}（期望 2，**不是 0** ✗）`);

  const total = cases.length + 3;
  console.log(`self-test: ${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

const bi = argValue("--bridge");
const BRIDGE = bi ? (isAbsolute(bi) ? bi : join(ROOT, bi)) : join(ROOT, "tools", "shuyonote-mcp", "index.mjs");
process.exit(run(ROOT, BRIDGE, argv.includes("--require-bridge")));
