// 能力注册表门禁。
//
// 校验五件事：
//   1. 注册表自身的完整性（id 唯一、权限存在、scope/kind 合法、必有实现函数名、必有 desc…）；
//   2. 生成物与源一致（生成物没跟上就失败，避免"改了源忘了生成"）；
//   3. 覆盖：每条能力声明的实现函数真的在 plugins.rs 里、且出现在作者文档里；
//   4. **参数口径：声明 ⟷ 代码**（下面 §3b）——"文档说必填、代码按可选读"这类
//      **不会报错、只会误导作者**的错，只能机械比对；
//   5. 交叉：legacyGlobals 指向的能力存在；声明的权限至少被一条能力用到（不留死权限）。
//
// 用法：node scripts/check-capabilities.mjs  （有问题即非零退出）

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, buildAll, OUTPUTS } from "./gen-capabilities.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const KINDS = new Set(["read", "write", "host"]);
const SCOPES = new Set(["current-space", "all-spaces", "app"]);
const TYPES = new Set(["string", "number", "boolean", "void", "object", "array"]);
const SEMVER = /^\d+\.\d+\.\d+$/;

const problems = [];
const fail = (msg) => problems.push(msg);

/** TS 侧适配器的个数（只用于输出读数，便于察觉适配器被删/漏写）。 */
let tsAdapters = 0;

/** 有没有默认值无法机械比对（dispatch 用非字面量读法）—— 报出来但不判红。 */
let defaultsUncompared = 0;

/**
 * 比较生成物时忽略行尾差异（CRLF vs LF）。
 *
 * 这条检查的语义是"改了注册表却忘了重新生成"，不是"检出行尾被转成了 CRLF"——
 * 后者在 Windows 上是常态（GitHub runner 默认 core.autocrlf=true）。把行尾当成差异
 * 会让门禁在 Windows 上必然失败（v1.84.6 的发布构建就是这样被打断的）。
 * 同时也加了 .gitattributes 统一为 LF，这里是第二道保险。
 */
const normEol = (t) => (t === null ? null : t.replace(/\r\n/g, "\n"));

const reg = loadRegistry();

// ---- 1. 完整性 ----
if (!SEMVER.test(reg.apiVersion)) fail(`apiVersion 必须是 x.y.z，实际 ${reg.apiVersion}`);

const permIds = new Set();
for (const p of reg.permissions) {
  if (permIds.has(p.id)) fail(`权限 id 重复：${p.id}`);
  permIds.add(p.id);
  if (!p.title) fail(`权限 ${p.id} 缺 title（安装界面要展示给人看）`);
  if (!p.desc) fail(`权限 ${p.id} 缺 desc`);
}

const capIds = new Set();
const usedPerms = new Set();
for (const c of reg.capabilities) {
  if (capIds.has(c.id)) fail(`能力 id 重复：${c.id}`);
  capIds.add(c.id);
  if (!c.title) fail(`能力 ${c.id} 缺 title`);
  // 描述是**作者文档的唯一来源**：缺了它，那份"只看这一份就能写出插件"的文档里就会出现一个
  // 空白格子，而没人会为此报错——所以这里把它变成门禁（原先只对 ai:true 的能力要求 desc）。
  if (!c.desc) fail(`能力 ${c.id} 缺 desc（作者文档的能力表会留一个空白格子）`);
  if (!KINDS.has(c.kind)) fail(`能力 ${c.id} 的 kind 非法：${c.kind}`);
  if (!SCOPES.has(c.scope)) fail(`能力 ${c.id} 的 scope 非法：${c.scope}`);
  if (!SEMVER.test(c.since)) fail(`能力 ${c.id} 的 since 必须是 x.y.z`);
  if (!Array.isArray(c.jsPath) || !c.jsPath.length || c.jsPath.some((k) => typeof k !== "string")) {
    fail(`能力 ${c.id} 的 jsPath 必须是非空字符串数组`);
  }
  if (c.permission !== null) {
    if (!permIds.has(c.permission)) fail(`能力 ${c.id} 引用了不存在的权限 ${c.permission}`);
    else usedPerms.add(c.permission);
  }
  if (!c.returns?.type || !TYPES.has(c.returns.type)) fail(`能力 ${c.id} 的 returns.type 非法`);
  if (!c.rust) fail(`能力 ${c.id} 缺 rust 实现函数名`);
  if (c.kind === "write") {
    if (!["draft", "immediate"].includes(c.mediate)) {
      fail(`写能力 ${c.id} 必须声明 mediate（draft = 落库前需用户确认 / immediate）`);
    }
  } else if (c.mediate) {
    fail(`非写能力 ${c.id} 不该有 mediate`);
  }
  for (const a of c.args ?? []) {
    if (!a.name) fail(`能力 ${c.id} 有参数缺 name`);
    if (!TYPES.has(a.type)) fail(`能力 ${c.id} 的参数 ${a.name} 类型非法：${a.type}`);
  }
  if (c.since !== reg.apiVersion && Number(c.since.split(".")[0]) > Number(reg.apiVersion.split(".")[0])) {
    fail(`能力 ${c.id} 的 since(${c.since}) 比 apiVersion(${reg.apiVersion}) 还新`);
  }
}

for (const p of reg.permissions) {
  if (!usedPerms.has(p.id)) fail(`权限 ${p.id} 没有任何能力用到（死权限，应删掉或接上能力）`);
}

for (const g of reg.legacyGlobals) {
  if (!capIds.has(g.capability)) fail(`legacyGlobals 的 ${g.global} 指向不存在的能力 ${g.capability}`);
}

const codes = new Set();
for (const e of reg.errorCodes) {
  if (codes.has(e.code)) fail(`错误码重复：${e.code}`);
  codes.add(e.code);
  if (!e.desc) fail(`错误码 ${e.code} 缺 desc`);
}

// ---- 2. 生成物与源一致 ----
const files = buildAll(reg);
const stale = [];
for (const [rel, content] of Object.entries(files)) {
  let cur = null;
  try {
    cur = read(rel);
  } catch {
    cur = null;
  }
  if (normEol(cur) !== normEol(content)) stale.push(rel);
}
if (stale.length) {
  fail(`生成物与 capabilities/capabilities.json 不一致（跑 node scripts/gen-capabilities.mjs）：${stale.join(", ")}`);
}

// ---- 2b. AI 暴露的能力：元数据在这里生成，实现必须在适配表里 ----
const frontendAdapters = read("src/lib/capabilities/frontend.ts");
const aiMeta = read(OUTPUTS.aiTools);
const aiCaps = reg.capabilities.filter((c) => c.ai);
for (const c of aiCaps) {
  if (!c.desc) fail(`能力 ${c.id} 暴露给 AI（ai:true）但没有 desc——LLM 只能看到描述来选工具`);
  if (!new RegExp(`"${c.id}"\\s*:`).test(frontendAdapters)) {
    fail(`能力 ${c.id} 暴露给 AI，但 src/lib/capabilities/frontend.ts 里没有它的前端实现`);
  }
  if (!aiMeta.includes(`"${c.id}"`)) fail(`能力 ${c.id} 没有出现在生成的 AI 工具元数据里`);
}
if (aiCaps.length === 0) fail("没有任何能力暴露给 AI（ai:true）——AI 宿主会失去全部工具");

// ---- 3. 覆盖：实现函数在 plugins.rs 里、能力 id 在作者文档里 ----
const pluginsRs = read("src-tauri/src/plugins.rs");
const docs = read(OUTPUTS.docs);
const shim = files[OUTPUTS.shim];

for (const c of reg.capabilities) {
  if (!new RegExp(`fn ${c.rust}\\s*\\(`).test(pluginsRs)) {
    fail(`能力 ${c.id} 声明的实现 fn ${c.rust} 在 src-tauri/src/plugins.rs 里找不到`);
  }
  if (!docs.includes(c.id)) fail(`能力 ${c.id} 没有出现在作者文档 ${OUTPUTS.docs} 里`);
  if (!shim.includes(`"${c.id}"`)) fail(`能力 ${c.id} 没有出现在生成的 shim 里（api.* 暴露不到）`);
}

// ---- 3b. 参数口径：注册表里声明的必填/可选，必须与 dispatch 里怎么读它一致 ----
//
// 为什么值得专门一条检查：这类不一致**不会报错**——`required: true` 而代码按可选读，
// 作者省略参数时不会失败、只是行为与他读到的不一样；反过来 `required: false` 而代码用
// `arg_str` 读，作者按文档省略参数就直接收到一个 bad_args。两者都只坑作者，不坑写代码的人，
// 所以没人会自然地发现它们（本仓已经手工撞到过好几次：`blocks.list` 的 pageId、
// `backlinks.list`/`files.list` 的描述、能力表里 13 个空白描述）。
//
// 做法是**按括号配对**从 dispatch 的 match 块里切出每条能力的 arm，看它怎么读参数：
//   `arg_str("x")`      → 必填（省略即报错）
//   `arg_opt_str("x")`  → 可选
//   `arg_i64("x", 默认)` → 可选
//   `args.get("x")`     → 可选（函数内部自己兜默认）
//   `scope_arg(&args)`  → `scope` 参数走统一解析
// 然后与注册表的 `args[].required` 对照；再顺手检查 desc 里该参数的窗口里有没有
// 「必填 / 可选 / 省略」这类与标记相反的说法。
function dispatchArms(src) {
  const start = src.indexOf("let out = match cap.id {");
  if (start < 0) return null;
  const end = src.indexOf("\n    };\n", start);
  const body = src.slice(start, end < 0 ? undefined : end);
  const arms = new Map();
  const re = /"([a-z][\w.]*)"\s*=>/g;
  let m;
  while ((m = re.exec(body))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let out = "";
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      out += ch;
    }
    arms.set(m[1], out.replace(/\s+/g, " ").trim());
  }
  return arms;
}

const arms = dispatchArms(pluginsRs);
if (!arms) {
  fail("在 plugins.rs 里找不到 dispatch 的 match 块（识别不了参数口径）——检查脚本是否要跟着代码改");
} else {
  const namesIn = (arm, re) => new Set([...arm.matchAll(re)].map((x) => x[1]));
  for (const c of reg.capabilities) {
    const arm = arms.get(c.id);
    if (arm === undefined) {
      fail(`能力 ${c.id} 在 dispatch 里没有分支（注册表说有，代码里没有）`);
      continue;
    }
    const readRequired = namesIn(arm, /arg_str\("(\w+)"\)/g);
    const readOptional = new Set([
      ...namesIn(arm, /arg_opt_str\("(\w+)"\)/g),
      ...namesIn(arm, /arg_i64\("(\w+)"/g),
      ...namesIn(arm, /args\.get\("(\w+)"\)/g),
    ]);
    if (arm.includes("scope_arg(")) readOptional.add("scope");

    for (const a of c.args ?? []) {
      const required = a.required === true;
      const readAs = readRequired.has(a.name) ? "required" : readOptional.has(a.name) ? "optional" : "never";
      if (readAs === "never") {
        fail(`能力 ${c.id} 声明了参数 ${a.name}，但 dispatch 里根本没读它（作者照文档传了也没用）`);
      } else if (required && readAs === "optional") {
        fail(`能力 ${c.id} 的参数 ${a.name} 声明必填、代码按可选读（作者省略它不会报错 → 文档在撒谎）`);
      } else if (!required && readAs === "required") {
        fail(`能力 ${c.id} 的参数 ${a.name} 声明可选、代码用 arg_str 读（作者照文档省略会直接报 bad_args）`);
      }
    }
    for (const name of new Set([...readRequired, ...readOptional])) {
      if (!(c.args ?? []).some((a) => a.name === name)) {
        fail(`能力 ${c.id} 的代码读了参数 ${name}，但注册表没声明它（作者文档里看不到这个参数）`);
      }
    }

    // **默认值口径**：注册表声明的 `default` 必须与 dispatch 里的字面默认值相同。
    // 这条是 2026-09-18 加的，它当天就抓到一个真的：`pages.search.limit` 注册表与 AI 工具面
    // （生成物）都写 **8**，而 dispatch 是 `arg_i64("limit", 20)` ⇒ 桌面上默认返回 20 条、Web 上 8 条，
    // 模型看到的工具说明却是 8。这类"默认值不同"比"参数没读"更隐蔽：两边都能跑、都返回合理结果。
    // 只比对字面量；用别的方式读默认值（如 `args.get(..).unwrap_or(..)`）时无法机械比对，
    // 计数后在总结行里报出来（**可见但不判红**，免得把正当写法误伤）。
    for (const a of c.args ?? []) {
      if (a.default === undefined) continue;
      const num = arm.match(new RegExp(`arg_i64\\("${a.name}"\\s*,\\s*(-?\\d+)`));
      const str = arm.match(new RegExp(`arg_(?:opt_)?str\\("${a.name}"\\s*,\\s*"([^"]*)"`));
      const lit = num ? num[1] : str ? str[1] : null;
      if (lit === null) {
        defaultsUncompared++;
        continue;
      }
      if (String(a.default) !== lit) {
        fail(
          `能力 ${c.id} 的参数 ${a.name} 默认值不一致：注册表 ${JSON.stringify(a.default)} ` +
            `vs dispatch ${JSON.stringify(lit)}（作者看到的默认值与实际行为不同）`,
        );
      }
    }

    // desc 里逐参数的窗口：该参数名 → 下一个参数名之间，不能出现与标记相反的说法
    const desc = c.desc ?? "";
    const argNames = (c.args ?? []).map((a) => a.name);
    for (const a of c.args ?? []) {
      const at = desc.search(new RegExp(`\\b${a.name}\\b`));
      if (at < 0) continue;
      const rest = desc.slice(at + a.name.length);
      let cut = rest.length;
      for (const other of argNames) {
        if (other === a.name) continue;
        const j = rest.indexOf(other);
        if (j >= 0 && j < cut) cut = j;
      }
      const win = rest.slice(0, cut);
      const saysRequired = win.includes("必填");
      const saysOptional = win.includes("可选") || win.includes("省略");
      if (a.required === true && saysOptional) {
        fail(`能力 ${c.id} 的参数 ${a.name} 是必填，但 desc 里写成可选/可省略：「…${win.trim().slice(0, 40)}」`);
      }
      if (a.required !== true && saysRequired) {
        fail(`能力 ${c.id} 的参数 ${a.name} 是可选的，但 desc 里写成必填：「…${win.trim().slice(0, 40)}」`);
      }
    }
  }
}

// 注册表条数兜底：小于 1 说明文件被写坏了
if (reg.capabilities.length === 0) fail("capabilities 为空");

/** 去掉行注释与块注释（`//` 出现在字符串里的少数情况会让检查变松，不会误报）。 */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * 顶层 `function name(...) { ... }` 读到的 `args.<参数名>` 集合。
 *
 * 为什么需要它：适配器常常不就地读参数，而是交给一处助手统一读
 * （`blocks.list` / `backlinks.list` 都是 `targetPage(args, ctx)` 读 `args.pageId`）。
 * 门禁若只看适配器函数体，就会把"读了、只是集中在助手"误判成"没读"——
 * 这是我在加强版判据上第一次跑就撞到的误报。
 */
function helperReads(src) {
  const out = [];
  const re = /^function\s+(\w+)\s*\([^)]*\)[^{]*\{/gm;
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    const end = src.indexOf("\n}", start); // 顶层函数以行首 `}` 结束
    const body = stripComments(src.slice(start, end < 0 ? src.length : end));
    const params = new Set([...body.matchAll(/\bargs\.(\w+)/g)].map((x) => x[1]));
    if (params.size) out.push({ name: m[1], params });
  }
  return out;
}

// ---- TS 侧（`src/lib/capabilities/frontend.ts` 的适配器）----
// 为什么必须两侧都查（2026-09-18 加）。原先只查 Rust 的 dispatch，于是**注册表承诺、
// TS 侧不兑现**这类分歧完全没有信号 —— 当天就是这么漏掉的：`blocks.list` 在注册表里
// 声明 `limit`（默认 100），Rust 侧 `limit.clamp(1,500).take(limit)` 是兑现的，
// 而 TS 适配器**根本没读它** ⇒ 同一段插件代码在 Web 上"传了也没用"、在桌面上生效；
// 同一个 `pageId` 声明可选（省略=当前页），TS 却当必填直接报错。
// 这类 bug 不会让任何测试变红，只会让两个平台返回不一样的东西。
{
  const tsPath = join(root, "src", "lib", "capabilities", "frontend.ts");
  const ts = existsSync(tsPath) ? readFileSync(tsPath, "utf8") : null;
  if (ts === null) {
    fail("找不到 src/lib/capabilities/frontend.ts（识别不了 TS 侧的参数口径）");
  } else {
    // 适配器函数体：从 `"pages.get": async (args) => {` 到下一个顶层键。这种粗切够用，
    // 因为门禁只做取值形态的检查；切片错位最多让检查变松，不会误报。
    const bodies = new Map();
    const marks = [...ts.matchAll(/^ {2}"([\w.]+)":\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gm)].map((m) => ({
      id: m[1],
      start: m.index + m[0].length,
    }));
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : ts.length;
      bodies.set(marks[i].id, ts.slice(marks[i].start, end));
    }
    for (const c of reg.capabilities) {
      const raw = bodies.get(c.id);
      if (raw === undefined) continue; // 这条能力没有 Web 适配器（不是本段要管的事）
      // ⚠️ **先剥注释**：不然"注释里提到过 limit"就能把检查骗过去 —— 我第一版就是这样，
      // 变异测试当场证伪（把 `args.limit` 换成常量后门禁仍然绿）。判据只能看**取值形态**。
      const body = stripComments(raw);
      // 参数常常不是就地读的，而是交给助手统一读（如 `targetPage(args, ctx)` 读 `args.pageId`）。
      // 门禁要顺着这一层看到真正的取值处，否则会把"读了但集中在助手"误判成"没读"。
      const delegated = new Set();
      for (const h of helperReads(ts)) {
        if (!new RegExp(`\\b${h.name}\\s*\\(\\s*args\\b`).test(body)) continue;
        for (const p of h.params) delegated.add(p);
      }
      for (const a of c.args ?? []) {
        const n = a.name;
        if (delegated.has(n)) continue; // 经助手读到
        const forms = [
          new RegExp(`\\bargs\\.${n}\\b`), // args.limit
          new RegExp(`\\bargs\\[\\s*["'\`]${n}["'\`]\\s*\\]`), // args["limit"]
          new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*args\\b`), // const { limit } = args
          // 把**参数名**连同 args 一起交给统一读法的助手：`intArg(args, "limit", 默认, 1, 上限)`。
          // 这是本仓 2026-09-18 之后推荐的写法（默认值/夹取/非法值只实现一次），门禁必须认它。
          new RegExp(`\\bargs\\s*,\\s*["'\`]${n}["'\`]`),
        ];
        if (!forms.some((re) => re.test(body))) {
          fail(
            `能力 ${c.id} 声明了参数 ${n}，但 TS 适配器里没有以取值形态读它` +
              `（args.${n} / args["${n}"] / 解构 / 交给读了它的助手）—— ` +
              `Web 上作者照文档传了也没用；Rust 侧读了不代表这一侧读了`,
          );
        }
      }
      for (const m of body.matchAll(/\bargs\.(\w+)/g)) {
        const name = m[1];
        if (!(c.args ?? []).some((a) => a.name === name)) {
          fail(`能力 ${c.id} 的 TS 适配器读了参数 ${name}，但注册表没声明它（作者文档里看不到这个参数）`);
        }
      }
    }
    tsAdapters = bodies.size;
  }
}

// ---- 输出 ----
if (problems.length) {
  console.error("能力注册表门禁未通过：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `能力注册表一致：${reg.capabilities.length} 条能力 / ${reg.permissions.length} 项权限 / ` +
    `${reg.legacyGlobals.length} 个兼容别名 / ${reg.errorCodes.length} 个错误码；` +
    `API v${reg.apiVersion}；生成物 ${Object.keys(files).length} 个文件；` +
    `TS 适配器 ${tsAdapters} 个（参数口径两侧都比对）` +
    (defaultsUncompared ? `；另有 ${defaultsUncompared} 个默认值是非字面量读法，未自动比对（请人工看一眼）` : ""),
);
