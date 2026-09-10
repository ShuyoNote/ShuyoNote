// 能力注册表门禁。
//
// 校验四件事：
//   1. 注册表自身的完整性（id 唯一、权限存在、scope/kind 合法、必有实现函数名…）；
//   2. 生成物与源一致（生成物没跟上就失败，避免"改了源忘了生成"）；
//   3. 覆盖：每条能力声明的实现函数真的在 plugins.rs 里、且出现在作者文档里；
//   4. 交叉：legacyGlobals 指向的能力存在；声明的权限至少被一条能力用到（不留死权限）。
//
// 用法：node scripts/check-capabilities.mjs  （有问题即非零退出）

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

// 注册表条数兜底：小于 1 说明文件被写坏了
if (reg.capabilities.length === 0) fail("capabilities 为空");

// ---- 输出 ----
if (problems.length) {
  console.error("能力注册表门禁未通过：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `能力注册表一致：${reg.capabilities.length} 条能力 / ${reg.permissions.length} 项权限 / ` +
    `${reg.legacyGlobals.length} 个兼容别名 / ${reg.errorCodes.length} 个错误码；` +
    `API v${reg.apiVersion}；生成物 ${Object.keys(files).length} 个文件`,
);
