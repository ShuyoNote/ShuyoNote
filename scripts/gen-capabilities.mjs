// 能力注册表的代码生成器（单一事实源 → 各处生成物）。
//
// 源：capabilities/capabilities.json
// 生成：
//   1. capabilities/plugin-api-shim.js       —— 插件看到的 `api.*`（唯一 ABI 面）
//   2. src-tauri/src/capabilities_gen.rs     —— Rust 绑定表（id → 权限 / scope / 实现函数名）
//   3. packages/plugin-types/index.d.ts      —— 作者用的类型包 @shuyonote/plugin-types
//   4. packages/plugin-types/globals.d.ts    —— 脚本式插件的全局声明（`api` / `register`）
//   5. packages/plugin-types/package.json    —— 类型包元数据
//   6. docs/plugin-api.md                    —— 面向作者的 API 文档
//   7. src/lib/capabilities/aiTools.meta.ts  —— AI 宿主工具元数据
//
// 用法：
//   node scripts/gen-capabilities.mjs           写入生成物
//   node scripts/gen-capabilities.mjs --check    只校验生成物是否与源一致（CI 用）
//
// 为什么不手写：能力定义此前散在 5 处（Rust 宿主函数、api.ts、commands.ts、web.ts、ai/tools.ts），
// 再多一个消费方（插件）就必然出现第二份实现并漂移。这里只留一份源。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "capabilities/capabilities.json";

export const OUTPUTS = {
  shim: "capabilities/plugin-api-shim.js",
  rust: "src-tauri/src/capabilities_gen.rs",
  types: "packages/plugin-types/index.d.ts",
  globals: "packages/plugin-types/globals.d.ts",
  themeMeta: "src/lib/capabilities/theme.meta.ts",
  pkg: "packages/plugin-types/package.json",
  docs: "docs/plugin-api.md",
  aiTools: "src/lib/capabilities/aiTools.meta.ts",
  menusMeta: "src/lib/capabilities/menus.meta.ts",
};

const HEADER = "本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。";

export function loadRegistry() {
  const reg = JSON.parse(readFileSync(resolve(root, SRC), "utf8"));
  return reg;
}

const jsSig = (cap) => `api.${cap.jsPath.join(".")}(${cap.args.map((a) => a.name).join(", ")})`;

/** JS 侧实参 → 传给 __cap 的对象字面量片段。 */
function argExpr(a) {
  const coerce = a.type === "number" ? "Number" : "String";
  // 关键：`undefined` 必须原样传下去（JSON.stringify 会丢掉这个键），
  // 否则 String(undefined) = "undefined" 会让宿主把"没传参"当成"传了个字符串"，
  // 变成静默的错误输入（曾把 api.blocks.append("文本") 的文本当成 pageId）。
  if (a.required === false && a.default !== undefined) {
    return `${a.name}: ${a.name} === undefined ? ${JSON.stringify(a.default)} : ${coerce}(${a.name})`;
  }
  if (a.required === false) {
    return `${a.name}: ${a.name} === undefined ? undefined : ${coerce}(${a.name})`;
  }
  return `${a.name}: ${a.name} === undefined ? undefined : ${coerce}(${a.name})`;
}

export function genShim(reg) {
  const lines = [];
  lines.push(`// ${HEADER}`);
  lines.push("// 插件代码里能看到的唯一 ABI 面。宿主只认 `__cap(method, argsJson)` 这一个原语，");
  lines.push("// 所以换引擎/加传输都不破坏插件（见方案 §3.3）。");
  lines.push("");
  lines.push("function __capCall(method, args) {");
  lines.push("  // 宿主统一返回 JSON 字符串：能解析就解析，不能就原样返回（保持宽容）。");
  lines.push('  var raw = __cap(method, JSON.stringify(args || {}));');
  lines.push("  try { return JSON.parse(raw); } catch (e) { return raw; }");
  lines.push("}");
  lines.push("");

  // 按 jsPath 第一段分组，还原 api.page.current() 这样的嵌套形状。
  const tree = {};
  for (const cap of reg.capabilities) {
    const [head, ...rest] = cap.jsPath;
    const leaf = rest.length ? rest[rest.length - 1] : head;
    const ns = rest.length ? rest.slice(0, -1).reduce((o, k) => (o[k] ??= {}), (tree[head] ??= {})) : tree;
    const target = rest.length ? ns : tree;
    target[leaf] = cap;
  }

  const emit = (obj, indent) => {
    const pad = " ".repeat(indent);
    return Object.entries(obj)
      .map(([key, val]) => {
        if (val && val.id) {
          const params = val.args.map((a) => a.name).join(", ");
          const body = val.args.map(argExpr).join(", ");
          return `${pad}${key}: function(${params}) { return __capCall(${JSON.stringify(val.id)}, {${body ? " " + body + " " : ""}}); }`;
        }
        return `${pad}${key}: {\n${emit(val, indent + 2)}\n${pad}}`;
      })
      .join(",\n");
  };

  lines.push("var api = {");
  lines.push(emit(tree, 2));
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

export function genRust(reg) {
  const l = [];
  l.push(`// ${HEADER}`);
  l.push("");
  l.push("use serde::Serialize;");
  l.push("");
  l.push("/// 生成物：字段不全都在当前版本被读到，但它们是被门禁与后续能力档用到的事实。");
  l.push("#[allow(dead_code)]");
  l.push("#[derive(Debug, Clone, Copy)]");
  l.push("pub struct Capability {");
  l.push("    pub id: &'static str,");
  l.push("    pub kind: &'static str,");
  l.push("    pub scope: &'static str,");
  l.push("    pub permission: Option<&'static str>,");
  l.push("    pub since: &'static str,");
  l.push("    /// 写能力的中介方式：`draft`（落库前需用户确认）/ `immediate`（即时）/ `-`（非写）。");
  l.push("    pub mediate: &'static str,");
  l.push("    /// 实现函数名（在 plugins.rs 里），供 check-capabilities 做覆盖校验。");
  l.push("    pub rust: &'static str,");
  l.push("}");
  l.push("");
  l.push(`pub const API_VERSION: &str = ${JSON.stringify(reg.apiVersion)};`);
  l.push(`pub const API_MAJOR: u32 = ${Number(reg.apiVersion.split(".")[0])};`);
  l.push("");
  l.push("pub const CAPABILITIES: &[Capability] = &[");
  for (const c of reg.capabilities) {
    const perm = c.permission === null ? "None" : `Some(${JSON.stringify(c.permission)})`;
    l.push(
      `    Capability { id: ${JSON.stringify(c.id)}, kind: ${JSON.stringify(c.kind)}, scope: ${JSON.stringify(
        c.scope,
      )}, permission: ${perm}, since: ${JSON.stringify(c.since)}, mediate: ${JSON.stringify(c.mediate ?? "-")}, rust: ${JSON.stringify(c.rust)} },`,
    );
  }
  l.push("];");
  l.push("");
  l.push("/// 权限清单（manifest 校验 + 旧 manifest 无 permissions 时的基线授权 + 安装界面展示用）。");
  l.push("#[allow(dead_code)]");
  l.push("#[derive(Debug, Clone, Copy)]");
  l.push("pub struct Permission {");
  l.push("    pub id: &'static str,");
  l.push("    pub title: &'static str,");
  l.push("    pub risk: &'static str,");
  l.push("}");
  l.push("");
  l.push("pub const PERMISSION_LIST: &[Permission] = &[");
  for (const p of reg.permissions) {
    l.push(
      `    Permission { id: ${JSON.stringify(p.id)}, title: ${JSON.stringify(p.title)}, risk: ${JSON.stringify(
        p.risk,
      )} },`,
    );
  }
  l.push("];");
  l.push("");
  l.push("pub fn permission(id: &str) -> Option<&'static Permission> {");
  l.push("    PERMISSION_LIST.iter().find(|p| p.id == id)");
  l.push("}");
  l.push("");
  l.push("/// 全部权限 id（基线授权用）。");
  l.push("#[allow(dead_code)]");
  l.push("pub fn permission_ids() -> Vec<&'static str> {");
  l.push("    PERMISSION_LIST.iter().map(|p| p.id).collect()");
  l.push("}");
  l.push("");
  l.push("/// v1 之前的老全局名 → 能力 id（脚本检查用，运行时由宿主直接注册为别名）。");
  l.push("#[allow(dead_code)]");
  l.push("pub const LEGACY_GLOBALS: &[(&str, &str)] = &[");
  for (const g of reg.legacyGlobals) l.push(`    (${JSON.stringify(g.global)}, ${JSON.stringify(g.capability)}),`);
  l.push("];");
  l.push("");
  l.push("/// 一个事件：`id` 是 manifest `events[].on` 用的名字。");
  l.push("#[derive(Serialize, Clone, Debug)]");
  l.push("pub struct PluginEvent {");
  l.push("    pub id: &'static str,");
  l.push("    pub title: &'static str,");
  l.push("    pub desc: &'static str,");
  l.push("    pub since: &'static str,");
  l.push("    /// 宿主是否已经在发这个事件。**没接的不会进类型包**，且校验器会如实告知订阅者。");
  l.push("    pub hosted: bool,");
  l.push("}");
  l.push("");
  l.push("pub const EVENTS: &[PluginEvent] = &[");
  for (const e of reg.events) {
    l.push(`    PluginEvent { id: ${JSON.stringify(e.id)}, title: ${JSON.stringify(e.title)}, desc: ${JSON.stringify(e.desc)}, since: ${JSON.stringify(e.since)}, hosted: ${e.hosted} },`);
  }
  l.push("];");
  l.push("");
  l.push("/// 一个触发面：命令能出现在哪里（作者在 `register({ menus })` 里声明）。");
  l.push("#[derive(Serialize, Clone, Debug)]");
  l.push("pub struct PluginMenu {");
  l.push("    pub id: &'static str,");
  l.push("    pub title: &'static str,");
  l.push("    /// 宿主是否已经接了这个入口。**没接的值会被如实告知作者**，而不是静默丢掉。");
  l.push("    pub hosted: bool,");
  l.push("    pub desc: &'static str,");
  l.push("}");
  l.push("");
  l.push("pub const MENUS: &[PluginMenu] = &[");
  for (const m of reg.menus) {
    l.push(`    PluginMenu { id: ${JSON.stringify(m.id)}, title: ${JSON.stringify(m.title)}, hosted: ${m.hosted}, desc: ${JSON.stringify(m.desc)} },`);
  }
  l.push("];");
  l.push("");
  l.push("/// 一个可主题化的 CSS 变量。");
  l.push("#[derive(Serialize, Clone, Debug)]");
  l.push("pub struct ThemeToken {");
  l.push("    pub name: &'static str,");
  l.push("    /// `color` / `length`：值的形态检查据此做。");
  l.push("    pub kind: &'static str,");
  l.push("    pub desc: &'static str,");
  l.push("}");
  l.push("");
  l.push("pub const THEME_TOKENS: &[ThemeToken] = &[");
  for (const t of reg.theme.tokens) {
    l.push(`    ThemeToken { name: ${JSON.stringify(t.name)}, kind: ${JSON.stringify(t.kind)}, desc: ${JSON.stringify(t.desc)} },`);
  }
  l.push("];");
  l.push("");
  l.push("pub fn theme_token(name: &str) -> Option<&'static ThemeToken> {");
  l.push("    THEME_TOKENS.iter().find(|t| t.name == name)");
  l.push("}");
  l.push("");
  l.push("pub fn menu(id: &str) -> Option<&'static PluginMenu> {");
  l.push("    MENUS.iter().find(|m| m.id == id)");
  l.push("}");
  l.push("");
  l.push("/// 一种导入触发：manifest `triggers[].kind` 只能填这里有的值。");
  l.push("///");
  l.push("/// 与 `menus` 同一类事实（作者声明 → 宿主渲染一个入口），所以同样放在注册表里：");
  l.push("/// 校验器据此区分「kind 不认识」（错误）与「kind 认识但宿主还没接」（提醒）。");
  l.push("#[derive(Serialize, Clone, Debug)]");
  l.push("pub struct PluginTrigger {");
  l.push("    pub id: &'static str,");
  l.push("    pub title: &'static str,");
  l.push("    /// 宿主是否已经接了这个触发。");
  l.push("    pub hosted: bool,");
  l.push("    pub desc: &'static str,");
  l.push("}");
  l.push("");
  l.push("pub const TRIGGERS: &[PluginTrigger] = &[");
  for (const t of reg.triggers) {
    l.push(`    PluginTrigger { id: ${JSON.stringify(t.id)}, title: ${JSON.stringify(t.title)}, hosted: ${t.hosted}, desc: ${JSON.stringify(t.desc)} },`);
  }
  l.push("];");
  l.push("");
  l.push("pub fn trigger(id: &str) -> Option<&'static PluginTrigger> {");
  l.push("    TRIGGERS.iter().find(|t| t.id == id)");
  l.push("}");
  l.push("");
  l.push("/// 按 id 找事件（manifest 声明校验用）。");
  l.push("pub fn event(id: &str) -> Option<&'static PluginEvent> {");
  l.push("    EVENTS.iter().find(|e| e.id == id)");
  l.push("}");
  l.push("");
  l.push("pub fn lookup(id: &str) -> Option<&'static Capability> {");
  l.push("    CAPABILITIES.iter().find(|c| c.id == id)");
  l.push("}");
  l.push("");
  return l.join("\n");
}

export function genTypes(reg) {
  const l = [];
  l.push(`// ${HEADER}`);
  l.push(`// 用法：tsconfig 里把 "@shuyonote/plugin-types" 指到本文件，即可获得 api.* 的补全与类型检查。`);
  l.push("");
  l.push("/** 命令参数：宿主按这份声明**渲染参数表单**，所以声明什么就渲染什么、就校验什么。 */");
  l.push("export interface PluginCommandParam {");
  l.push("  /** 参数名（`run(args)` 里的键）。 */");
  l.push("  name: string;");
  l.push("  /** 表单上显示的名字；不写就用 `name`。 */");
  l.push("  label?: string;");
  l.push('  /** 控件类型：文本框 / 数字框 / 复选框 / 下拉框（默认 `string`）。 */');
  l.push('  type?: "string" | "number" | "boolean" | "select";');
  l.push("  /** 必填：留空时表单会拒绝提交（而不是传空串下去）。 */");
  l.push("  required?: boolean;");
  l.push("  placeholder?: string;");
  l.push('  /** `type: "select"` 的候选项：字符串数组，或 `{ value, label }`。 */');
  l.push("  options?: (string | { value: string; label?: string })[];");
  l.push("  /** 默认值（表单预填）。 */");
  l.push("  default?: string | number | boolean;");
  l.push("}");
  l.push("");
  l.push("/**");
  l.push(" * 插件命令：`register(...)` 注册后出现在命令面板（Ctrl+K）。");
  l.push(" *");
  l.push(" * 返回值两种形态：**字符串**（显示在命令面板底部）或**结构化对象**");
  l.push(" * （`{ message, insert, toasts }`，等价于调用对应的宿主原语）。");
  l.push(" */");
  l.push("export interface PluginCommand {");
  l.push("  id: string;");
  l.push("  title: string;");
  l.push("  description?: string;");
  l.push("  /** 执行后关闭命令面板（适合跳转类命令）。 */");
  l.push("  closeOnRun?: boolean;");
  l.push("  /** 声明参数后，宿主会先弹出参数表单再执行（`run(args)` 收到整理好的对象）。 */");
  l.push("  params?: PluginCommandParam[];");
  l.push("  /** 额外出现在哪些触发面（不写则只在命令面板里）。 */");
  l.push("  menus?: PluginMenuName[];");
  l.push("  /** 抛错会被宿主转成可见错误，不会让面板卡住。 */");
  l.push("  run: (args: PluginCommandArgs) => string | number | PluginCommandResult | void;");
  l.push("}");
  l.push("");
  l.push("/**");
  l.push(" * 命令参数值。");
  l.push(" *");
  l.push(" * **刻意不做静态推导**：参数值是用户在表单里现填的（字符串/数字/布尔），");
  l.push(" * 想按 `params` 声明推出精确类型需要让作者把数组写成 `as const`，而 TS 在");
  l.push(" * 这里对字面量类型的推断并不可靠——推出一个**看起来精确、其实会撒谎**的类型，");
  l.push(" * 比诚实地给出 `any` 更糟。插件里按自己的 `params` 声明收窄即可。");
  l.push(" */");
  l.push("export type PluginCommandArgs = Record<string, any>;");
  l.push("");
  l.push("/**");
  l.push(" * 宿主事件名（manifest `events[].on` 只能填这些）。");
  l.push(" *");
  l.push(" * **只列出宿主真的会发的**：写在类型外的值收不到任何事件，");
  l.push(" * 所以让它在这里报错，比让作者对着文档空等要好。");
  l.push(" */");
  l.push("export type PluginEventName =");
  for (const e of reg.events.filter((x) => x.hosted)) l.push(`  | ${JSON.stringify(e.id)}`);
  l.push("  ;");
  l.push("");
  l.push("/**");
  l.push(" * 主题插件可覆盖的设计变量（manifest `theme.tokens` 的键）。");
  l.push(" *");
  l.push(" * 只含外观值（颜色 / 圆角）——布局度量刻意不在内：让插件改列宽页宽会砸掉版面。");
  l.push(" */");
  l.push("export type ThemeTokenName =");
  for (const t of reg.theme.tokens) l.push(`  | ${JSON.stringify(t.name)}`);
  l.push("  ;");
  l.push("");
  l.push("/** 注册事件处理器：在插件顶层调用（与 `register` 并列）。 */");
  l.push("export declare function on(event: PluginEventName, handler: (payload: Record<string, any>) => void): void;");
  l.push("");
  l.push("/**");
  l.push(" * 命令的触发面（`register({ menus })`）。");
  l.push(" *");
  l.push(" * **只列出宿主已经实现的入口**——类型里没有的值写上去也不会出现，");
  l.push(" * 所以让它在这里报错，比让作者对着文档猜要好。");
  l.push(" */");
  const hostedMenus = reg.menus.filter((m) => m.hosted);
  l.push("export type PluginMenuName =");
  for (const m of hostedMenus) l.push(`  | ${JSON.stringify(m.id)}`);
  l.push("  ;");
  l.push("");
  l.push("/** 结构化返回：等价于调用对应的宿主原语。 */");
  l.push("export interface PluginCommandResult {");
  l.push("  /** 显示在命令面板底部的消息。 */");
  l.push("  message?: string;");
  l.push("  /** 追加到当前页末尾（需要 `write:page.current` 权限）。 */");
  l.push("  insert?: string;");
  l.push("  /** 提示（单个或数组），执行结束后弹给用户。 */");
  l.push("  toasts?: string | string[];");
  l.push("}");
  l.push("");
  l.push("/** 注册一个命令。插件顶层调用（每次执行都会重新 eval 插件代码）。 */");
  l.push("export declare function register(cmd: PluginCommand): void;");
  l.push("");
  l.push("/** 宿主能力面。需要哪些权限见各方法的注释——权限必须在 manifest.permissions 里声明。 */");

  const tree = {};
  for (const cap of reg.capabilities) {
    const path = cap.jsPath;
    let node = tree;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path[path.length - 1]] = cap;
  }
  const tsType = (t) =>
    ({ string: "string", number: "number", boolean: "boolean", void: "void" })[t] ?? "unknown";
  const emitTs = (obj, indent) => {
    const pad = " ".repeat(indent);
    return Object.entries(obj)
      .map(([key, val]) => {
        if (val && val.id) {
          const params = val.args
            .map((a) => {
              const opt = a.required === false ? "?" : "";
              const t = a.enum ? a.enum.map((e) => JSON.stringify(e)).join(" | ") : tsType(a.type);
              return `${a.name}${opt}: ${t}`;
            })
            .join(", ");
          const perm = val.permission ? `权限 \`${val.permission}\`` : "无需权限";
          const doc = [`  /** ${val.title}（${perm}；${val.since} 起）`];
          if (val.returns?.desc) doc.push(`   * 返回：${val.returns.desc}`);
          doc.push("   */");
          return `${doc.join("\n")}\n${pad}${key}(${params}): ${val.returns?.ts ?? tsType(val.returns?.type ?? "void")};`;
        }
        return `${pad}${key}: {\n${emitTs(val, indent + 2)}\n${pad}};`;
      })
      .join("\n");
  };
  l.push("export interface PluginApi {");
  l.push(emitTs(tree, 2));
  l.push("}");
  l.push("");
  l.push(`export declare const SDK_API_VERSION: ${JSON.stringify(reg.apiVersion)};`);
  l.push("");
  return l.join("\n");
}

/**
 * 脚本式插件的**全局**声明。
 *
 * 为什么必须有这一份：插件是**脚本**不是模块（Boa 里没有 `import`），作者写的是
 * `register({...})` 与 `api.pages.list()` 这种裸标识符。而 `index.d.ts` 是模块
 * （带 `export`），`// @ts-check` 的脚本文件看不见它的成员——于是"有类型包但没补全"
 * 就成了空档：作者要么手写 `import type`（脚本里用不了），要么干脆没类型。
 * 这里用 `declare global` 把两样东西变成全局，编辑器与 `tsc` 才能对脚本式插件生效。
 */
export function genGlobals(reg) {
  const l = [];
  l.push("// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。");
  l.push("// 用途：脚本式插件（非模块）的全局声明。作者的 tsconfig 里 include 本文件即可获得补全。");
  l.push('import type { PluginApi, PluginCommand, PluginEventName } from "./index";');
  l.push("");
  l.push("declare global {");
  l.push("  /** 宿主能力面。每一项需要的权限见 manifest.permissions（未声明的权限调用会被后端拒绝）。 */");
  l.push("  const api: PluginApi;");
  l.push("  /** 注册一个命令：在插件顶层调用，命令会出现在命令面板（Ctrl+K）。 */");
  l.push("  function register(cmd: PluginCommand): void;");
  l.push("  /** 注册事件处理器（需要 manifest `events` 里声明对应事件，否则收不到）。 */");
  l.push("  function on(event: PluginEventName, handler: (payload: Record<string, any>) => void): void;");
  l.push(`  /** 本应用支持的 API 版本（与 manifest.apiVersion 的主版本必须一致）。 */`);
  l.push(`  const SDK_API_VERSION: ${JSON.stringify(reg.apiVersion)};`);
  l.push("}");
  l.push("");
  l.push("export {};");
  l.push("");
  return l.join("\n");
}

/**
 * 主题 token 的**运行时**清单（类型包只有类型，前端应用主题要用真值）。
 * 与 Rust 侧 `THEME_TOKENS`、类型包 `ThemeTokenName` 同一个源，所以三边不会漂移。
 */
/**
 * 触发面（`register({ menus })`）的元数据 —— 前端要说得出「这个插件的命令会出现在哪」。
 *
 * 为什么也走生成物：插件管理要如实告诉用户"启用它之后，页面列表的行菜单里会多出东西"，
 * 而菜单的 id → 中文标题只有注册表一处有。前端手抄一份必然漂（id 改了没人发现）。
 * `hosted` 一起带上：还没实现的入口不该被说成"会出现"。
 */
export function genMenusMeta(reg) {
  const l = [];
  l.push("// " + HEADER);
  l.push("");
  l.push("/** 插件命令可以挂的宿主入口（`register({ menus: [...] })`）。 */");
  l.push("export interface PluginMenuMeta {");
  l.push("  id: string;");
  l.push("  title: string;");
  l.push("  desc: string;");
  l.push("  /** 宿主是否已经实现了这个入口（没实现的不会真的出现）。 */");
  l.push("  hosted: boolean;");
  l.push("}");
  l.push("");
  l.push("export const PLUGIN_MENUS: PluginMenuMeta[] = [");
  for (const m of reg.menus) {
    l.push(`  { id: ${JSON.stringify(m.id)}, title: ${JSON.stringify(m.title)}, desc: ${JSON.stringify(m.desc)}, hosted: ${m.hosted} },`);
  }
  l.push("];");
  l.push("");
  l.push("const BY_ID = new Map(PLUGIN_MENUS.map((m) => [m.id, m]));");
  l.push("");
  l.push("/** 入口的中文标题（不认识就退回 id——宁可显示得丑一点，也不要显示成空）。 */");
  l.push("export function pluginMenuTitle(id: string): string {");
  l.push("  return BY_ID.get(id)?.title ?? id;");
  l.push("}");
  l.push("");
  l.push("/** 这个入口宿主是否已经实现。 */");
  l.push("export function pluginMenuHosted(id: string): boolean {");
  l.push("  return BY_ID.get(id)?.hosted ?? false;");
  l.push("}");
  l.push("");
  return l.join("\n");
}

export function genThemeMeta(reg) {
  const l = [];
  l.push("// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。");
  l.push("");
  l.push("/** 一个可主题化的设计变量。 */");
  l.push("export interface ThemeToken {");
  l.push("  name: string;");
  l.push('  /** `color` / `length`：值的形态检查据此做。 */');
  l.push("  kind: string;");
  l.push("  desc: string;");
  l.push("}");
  l.push("");
  l.push("export const THEME_TOKENS: ThemeToken[] = [");
  for (const t of reg.theme.tokens) {
    l.push(`  { name: ${JSON.stringify(t.name)}, kind: ${JSON.stringify(t.kind)}, desc: ${JSON.stringify(t.desc)} },`);
  }
  l.push("];");
  l.push("");
  l.push("export const THEME_TOKEN_NAMES = THEME_TOKENS.map((t) => t.name);");
  l.push("");
  return l.join("\n");
}

export function genDocs(reg) {
  const l = [];
  l.push("# 插件 API（v" + reg.apiVersion + "）");
  l.push("");
  l.push(`> ${HEADER}`);
  l.push("> 本文面向**插件作者**：只要读这一份就能写出可安装、可运行的插件，不需要读源码。");
  l.push("");
  l.push("## 1. 最小插件（20 行）");
  l.push("");
  l.push("插件是磁盘上的一个目录，放在应用数据目录的 `plugins/<插件 id>/` 下（也可用「插件管理 → 从文件夹安装」）：");
  l.push("");
  l.push("```");
  l.push("plugins/my-plugin/");
  l.push("├── manifest.json");
  l.push("└── main.js");
  l.push("```");
  l.push("");
  l.push("`manifest.json`：");
  l.push("");
  l.push("```json");
  l.push("{");
  l.push('  "id": "my-plugin",');
  l.push('  "name": "我的插件",');
  l.push('  "version": "0.1.0",');
  l.push('  "description": "一句话说明",');
  l.push(`  "apiVersion": ${JSON.stringify(reg.apiVersion)},`);
  l.push('  "main": "main.js",');
  l.push('  "permissions": [');
  l.push('    { "id": "read:pages", "reason": "为了在提示里显示本空间页面数" }');
  l.push("  ]");
  l.push("}");
  l.push("```");
  l.push("");
  l.push("`main.js`：");
  l.push("");
  l.push("```js");
  l.push("register({");
  l.push('  id: "my-plugin.hello",');
  l.push('  title: "打个招呼",');
  l.push('  description: "显示本空间页面数",');
  l.push("  closeOnRun: false,");
  l.push("  run: function () {");
  l.push("    api.log(\"开始执行\");");
  l.push('    api.notify("本空间共 " + api.pages.count() + " 个页面");');
  l.push('    return "完成";');
  l.push("  },");
  l.push("});");
  l.push("```");
  l.push("");
  l.push("要点：");
  l.push("");
  l.push("- `id` 必须**等于目录名**；可用字符：字母、数字、`_`、`.`、`-`（推荐只用小写字母、数字与 `-`）；");
  l.push("- `main` 只能是同级文件名（`main.js` 或 `./main.js`）；");
  l.push("- 每次执行都会**重新 eval** 插件代码并新建一个沙箱 —— 不要在顶层做耗时工作；");
  l.push("- 返回的字符串会显示在命令面板底部；`closeOnRun: true` 执行后关闭面板。");
  l.push("");
  l.push("写完之后怎么跑起来、怎么排错：见 [§9 开发循环](#9-开发循环写--校验--看日志)。");
  l.push("");
  l.push("## 2. manifest 字段");
  l.push("");
  l.push("| 字段 | 必填 | 说明 |");
  l.push("|---|---|---|");
  l.push("| `id` | ✅ | 插件 id，必须等于目录名；单段，可用 `A-Za-z0-9_.-`（推荐 `[a-z0-9-]`） |");
  l.push("| `name` | ✅ | 显示名 |");
  l.push("| `version` | 建议 | 插件自身版本 |");
  l.push("| `description` | 建议 | 一句话说明 |");
  l.push("| `apiVersion` | ✅ | 本插件针对的 API 版本（当前 `" + reg.apiVersion + "`）；主版本不被支持时会被拒载 |");
  l.push('| `main` | | 入口文件，默认 `main.js` |');
  l.push("| `permissions` | ✅ | 见下节；**不写 = 默认零能力**（v1 之前的老插件会得到基线授权并收到警告） |");
  l.push("");
  l.push("## 3. 权限");
  l.push("");
  l.push("权限必须在 manifest 里**逐条声明**，安装/启用时会把「权限 + 理由」展示给用户；");
  l.push("运行时由宿主**逐次调用校验**——没声明的权限，调用会失败（不是被隐藏）。");
  l.push("");
  l.push("```json");
  l.push('"permissions": [');
  l.push('  { "id": "read:page.current", "reason": "为当前页生成摘要" }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("| 权限 id | 说明 | 风险 |");
  l.push("|---|---|---|");
  for (const p of reg.permissions) l.push(`| \`${p.id}\` | ${p.title}：${p.desc} | ${p.risk} |`);
  l.push("");
  l.push("## 4. 能力（`api.*`）");
  l.push("");
  l.push("| 能力 | 签名 | 需要权限 | scope | 写入中介 | 返回 | 自 |");
  l.push("|---|---|---|---|---|---|---|");
  for (const c of reg.capabilities) {
    l.push(
      `| \`${c.id}\` | \`${jsSig(c)}\` | ${c.permission ? "`" + c.permission + "`" : "—"} | \`${c.scope}\` | ${
        c.kind !== "write" ? "—" : c.mediate === "draft" ? "**草稿确认**" : "即时"
      } | ${c.returns?.type ?? "void"} | ${c.since} |`,
    );
  }
  l.push("");
  for (const c of reg.capabilities) {
    l.push(`### \`${c.id}\` — ${c.title}`);
    l.push("");
    l.push(`- 调用：\`${jsSig(c)}\``);
    l.push(`- 权限：${c.permission ? "`" + c.permission + "`" : "无需权限"}`);
    l.push(`- scope：\`${c.scope}\``);
    if (c.kind === "write") {
      l.push(
        `- 写入中介：**${c.mediate === "draft" ? "草稿确认（落库前需用户点确认）" : "即时生效"}**` +
          (c.mediateWhy ? ` —— ${c.mediateWhy}` : ""),
      );
    }
    if (c.returns?.desc) l.push(`- 返回：${c.returns.desc}`);
    if (c.args?.length) {
      l.push("- 参数：");
      for (const a of c.args) {
        const opt = a.required === false ? "（可选）" : "";
        const def = a.default !== undefined ? `，默认 \`${a.default}\`` : "";
        l.push(`  - \`${a.name}\`: \`${a.type}\`${opt}${def} —— ${a.desc ?? ""}`);
      }
    }
    l.push("");
  }
  l.push("## 4.5 命令参数（宿主渲染表单）");
  l.push("");
  l.push("命令可以声明参数：宿主会**照着声明**渲染一个表单，用户填完才执行（`run(args)` 收到整理好的对象）。");
  l.push("声明什么就渲染什么，所以不存在「表单和实现对不上」这回事。");
  l.push("");
  l.push("```js");
  l.push("register({");
  l.push('  id: "my-plugin.todo",');
  l.push('  title: "写一条待办",');
  l.push("  params: [");
  l.push('    { name: "text",    label: "内容", type: "string", required: true },');
  l.push('    { name: "minutes", label: "预计分钟", type: "number", default: 25 },');
  l.push('    { name: "urgent",  label: "标记紧急", type: "boolean" },');
  l.push('    { name: "bucket",  label: "归到", type: "select", options: ["今天", "本周"] }');
  l.push("  ],");
  l.push("  run: function (args) {");
  l.push('    return api.blocks.append(args.text + "（预计 " + args.minutes + " 分钟）");');
  l.push("  }");
  l.push("});");
  l.push("```");
  l.push("");
  l.push("规则（都可预期，不会悄悄替你做主）：");
  l.push("");
  l.push("- **必填留空 → 表单拒绝提交**（不会传空串下去，空串往往是有效值）；");
  l.push("- **非必填留空 → 不传这个键**，插件里 `args.x === undefined` 即可按「没给」处理；");
  l.push("- `number` 会转成数字，填了非数字会提示；`0` 是有效值；");
  l.push("- `boolean` **总是传布尔值**（没勾就是 `false`）；");
  l.push("- 类型写错（拼错的 `type`）按 `string` 处理——宁可给个文本框，也不让命令从面板里消失。");
  l.push("");
  l.push("两个诚实的边界：**参数值不做静态类型推导**（它来自运行期表单，`args` 是 `Record<string, any>`，");
  l.push("按自己的声明收窄即可）；**参数不构成安全边界**（它只会流进插件自己的 JS），真正碰数据的是 `api.*`，");
  l.push("");
  l.push("以及体积上限：");
  l.push("那一步宿主逐次校验权限与参数。");
  l.push("");
  l.push("### 4.5.1 更新插件时：新增权限/事件要用户重新确认");
  l.push("");
  l.push("**这一条会直接影响你怎么发新版**：用户启用插件的那一刻，宿主会把他当时看到的那份声明（权限 + 事件）记成一条**授权快照**。之后你把插件目录换成声明更大的版本时——");
  l.push("");
  l.push("- 宿主**暂停**这个插件（命令不执行、事件也不派发），并在插件管理里说清**新增了哪几项**；");
  l.push("- 用户点了「重新确认」之后才恢复运行。");
  l.push("");
  l.push("所以：");
  l.push("");
  l.push("- **别把「新增一项权限」当成小改动**——它会让插件停下等用户确认，用户没注意到就会以为插件坏了（插件管理里有明确的提示条与按钮，这是设计，不是故障）；");
  l.push("- **收敛声明（删掉权限/事件）不需要确认**，也不会暂停；只有新增会；");
  l.push("- 重新安装（卸载再装）等于重新开始：新装的插件默认未启用，用户启用时才记快照。");
  l.push("");
  l.push("## 4.6 事件钩子（manifest 声明 + `on(...)`）");
  l.push("");
  l.push("事件让插件在**用户没点命令**时也能跑（例如「保存后自动加今天的日期标签」）。");
  l.push("它要**两处**都写，缺一不可——这是有意的：manifest 是给用户看的授权面，");
  l.push("JS 里没注册就什么都不会发生，而 JS 里注册了但 manifest 没声明则收不到事件。");
  l.push("");
  l.push("```json");
  l.push('"events": [');
  l.push('  { "on": "page.saved", "reason": "每次保存后把今天的日期标签补上" }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("```js");
  l.push('on("page.saved", function (payload) {');
  l.push("  api.tags.add(todayTag());   // 省略 pageId 时作用于当前页；写操作仍然走草稿确认");
  l.push("});");
  l.push("```");
  l.push("");
  l.push("| 事件 | 触发时机 | 宿主是否已发 |");
  l.push("|---|---|---|");
  for (const e of reg.events) l.push(`| \`${e.id}\` | ${e.title}：${e.desc} | ${e.hosted ? "✅ 已在发" : "⏳ 还没接"} |`);
  l.push("");
  l.push("几条必须知道的规则：");
  l.push("");
  l.push("- **只有启用中的插件会收到事件**；");
  l.push("- **写操作仍然要用户确认**：事件里产出的草稿会汇总成一次确认（不会静默写入笔记）；");
  l.push("- **事件里的 `insert` 会被忽略**（没有人正在等你插入文本，凭空出现文字更糟）；");
  l.push("- **没声明 `events` 的老插件不会收到任何事件**（与权限的基线授权不同：在后台运行代码更不能默认给）；");
  l.push("- 事件处理器有**更短的墙钟预算**（保存路径上不该有慢活），超时会记进插件日志。");
  l.push("");
  l.push("## 4.7 触发面（命令出现在哪里）");
  l.push("");
  l.push("命令默认出现在命令面板（`Ctrl+K`）。想让它出现在别处，用 `menus` 声明：");
  l.push("");
  l.push("```js");
  l.push('register({ id: "my-plugin.today", title: "插入今天的日期", menus: ["slash"], run: function () { ... } });');
  l.push("```");
  l.push("");
  l.push("| 入口 | 说明 | 宿主是否已实现 |");
  l.push("|---|---|---|");
  for (const m of reg.menus) l.push(`| \`${m.id}\` | ${m.title}：${m.desc} | ${m.hosted ? "✅ 已实现" : "⏳ 还没做"} |`);
  l.push("");
  l.push("几条规则：");
  l.push("");
  l.push("- **类型包里只有已实现的入口**（`PluginMenuName`）——写上去没有的类型会直接编译报错，");
  l.push("  校验器也会提醒你哪些值当前还没有宿主入口（不会静默丢掉你写的声明）；");
  l.push("- 从 `/` 菜单触发的命令，如果它声明了参数，宿主会转交到命令面板让你填参数（同一套表单，不重复实现）；");
  l.push("- 写能力在任何入口都走草稿确认——触发方式不影响这条。");
  l.push("");
  l.push("## 4.8 插件设置（用户填、你只读）");
  l.push("");
  l.push("需要用户配置的东西（文件夹、条数、开关）声明在 manifest 里，宿主会在「插件管理 → 设置」"
  );
  l.push("渲染成表单。**写只发生在那里**：插件侧 `api.settings.get` 是只读的（对 `setting:` 命名空间");
  l.push("的写入会被后端拒绝）——这样用户看到的配置始终等于他亲手设的那个。");
  l.push("");
  l.push("```json");
  l.push('"settings": [');
  l.push('  { "key": "recentCount", "label": "显示条数", "type": "number", "default": 5 },');
  l.push('  { "key": "folder", "label": "归档到", "type": "string", "description": "留空＝当前空间根目录" },');
  l.push('  { "key": "verbose", "label": "详细日志", "type": "boolean", "default": false },');
  l.push('  { "key": "mode", "label": "排序", "type": "select", "options": ["最近更新", "标题"] }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("```js");
  l.push('var n = Number(api.settings.get("recentCount") || 5);   // 没设过返回 null');
  l.push("var pages = api.pages.list(n);");
  l.push("```");
  l.push("");
  l.push("几条规则：");
  l.push("");
  l.push("- **值由宿主校验**：`number` 一定是数字、`boolean` 一定是 true/false、`select` 一定在候选项里——");
  l.push("  所以插件不必防御「用户填了乱七八糟的东西」；");
  l.push("- **没设过返回 `null`**（不是空串）：据此退回你自己的默认值；");
  l.push("- **没声明的 key 会报错**（而不是返回 null）：key 名字写错是最常见的低级错误，静默返回 null 会让你查很久；");
  l.push("- **scope 由声明决定，不由你选**：`\"scope\": \"space\"`（默认）随空间 SQLCipher 加密，");
  l.push("  `\"scope\": \"app\"` 落 meta.db（**明文**，别放 token 这类东西）；");
  l.push("- 用户在设置里填的值存在插件自己的数据区（`plugin_data`），与 `api.kv` 同一张表、不同命名空间。");
  l.push("- **零代码插件也能用设置**：视图的查询字段可以写成 `{ \"fromSetting\": \"key\" }`，由宿主在渲染时解析（见 §4.9.1）——那种情况下「读设置的是宿主」，你依然不需要代码。");
  l.push("");
  l.push("## 4.9 零代码插件（`runtime` = `declarative`）");
  l.push("");
  l.push("不需要写 JS 也能做插件：把 `runtime` 设成 `declarative`，只声明**视图**，宿主负责查询与渲染。");
  l.push("整个插件就是一个 manifest.json——**没有代码，所以也没有可执行的东西**，这类插件的信任成本最低。");
  l.push("");
  l.push("```json");
  l.push("{");
  l.push('  "id": "reading-board", "name": "阅读统计", "version": "1.0.0",');
  l.push('  "runtime": "declarative", "apiVersion": "' + reg.apiVersion + '",');
  l.push('  "views": [ {');
  l.push('    "id": "recent", "title": "最近更新", "summary": true,');
  l.push('    "query": { "kind": "any", "updatedWithinDays": 30, "sort": "updated_desc", "limit": 20 },');
  l.push('    "columns": ["title", "kind", "updated_at", "days_since_update"]');
  l.push("  }, {");
  l.push('    "id": "board", "title": "待整理", "placement": "rail",');
  l.push('    "query": { "sort": "updated_desc", "limit": 20 },');
  l.push('    "columns": ["title", "days_since_update"]');
  l.push("  } ]");
  l.push("}");
  l.push("```");
  l.push("");
  l.push("`query` 可用字段：`kind`（`any` / `page` / `database`）、`titleContains`、`updatedWithinDays`、`sort`（`updated_desc` / `created_desc` / `title_asc` / `title_desc`）、`limit`（1–500）。");
  l.push("");
  l.push("`placement`：这个视图**开在哪里**——省略（或 `\"overlay\"`）是浮层，`\"rail\"` 是右侧常驻面板。");
  l.push("");
  l.push("| 落点 | 长什么样 | 什么时候用 |");
  l.push("|---|---|---|");
  l.push("| `overlay`（默认） | 占满屏幕的浮层，点空白或 × 关掉 | 「看一下就走」：查一查最近更新、翻一遍清单 |");
  l.push("| `rail` | 右侧常驻面板，与正文并排，点行**不关面板** | 「一边看正文一边看着它」：待整理清单、周回顾、写作时的参照表 |");
  l.push("");
  l.push("两种形态的表格完全一样（查询、列、汇总、点行打开那一页），差别只在**开在哪里、关不关**。");
  l.push("`rail` 的视图会在右侧竖条上占一个按钮（工具条那一列），停用插件后按钮随之消失。");
  l.push("");
  l.push("`columns` 可用列（宿主渲染什么，你只能从这里选）：");
  l.push("");
  l.push("| 列 | 说明 |");
  l.push("|---|---|");
  for (const [key, title] of [["title","标题"],["kind","类型"],["updated_at","更新时间"],["created_at","创建时间"],["days_since_update","距上次更新（天）"],["title_length","标题长度"]]) {
    l.push(`| \`${key}\` | ${title} |`);
  }
  l.push("");
  l.push("几条要知道的：");
  l.push("");
  l.push("- **声明式插件不申请权限、收不到事件**（它没有代码）——写了这些字段会被提醒而不是默默生效；");
  l.push("- 视图出现在命令面板里（搜「插件视图：…」），点开就是一张表，点某一行会打开那一页；");
  l.push("- 列名 / 排序 / kind / placement 写错**不会让视图打不开**，只是那一项按默认处理（落点不认识就是浮层），校验器会告诉你哪个值不认识；");
  l.push("- 想要条件逻辑就写 `logic` 档（有 `main.js`）——两者的能力不同，不要混着声明。");
  l.push("");
  l.push("### 4.9.1 让用户能调（查询字段引用设置）");
  l.push("");
  l.push("**零代码也能「用户可配」**：查询字段除了写死，还可以指向一个设置——用户改了设置，视图下次打开就按新条件查。");
  l.push("");
  l.push("```json");
  l.push('"settings": [');
  l.push('  { "key": "recentDays", "label": "看多少天内更新的", "type": "number", "default": 30 }');
  l.push("],");
  l.push('"views": [ {');
  l.push('  "id": "recent", "title": "最近更新", "summary": true,');
  l.push('  "query": { "updatedWithinDays": { "fromSetting": "recentDays" }, "limit": 20 },');
  l.push('  "columns": ["title", "updated_at"]');
  l.push("} ]");
  l.push("```");
  l.push("");
  l.push("规则（都可预期，不会悄悄替你做主）：");
  l.push("");
  l.push("- **设置表单还是宿主渲染的**：你在 `settings` 里声明什么，用户在「插件管理 → 设置」里就看到什么；你依然读不到它（没有代码），是**宿主**在渲染视图时把值解析进去；");
  l.push("- **默认值只有一处**：就是设置声明里的 `default`——不要在两边各写一个，那必然漂。用户没设过、你也没给 `default` 时，该字段按「没给」处理（即宿主的默认行为）；");
  l.push("- **类型要对得上**：数字字段（`updatedWithinDays` / `limit`）← `number` 设置（或候选项都是数字的 `select`）；`sort` / `kind` ← 候选项都在白名单里的 `select`（用 `string` 会提醒你：用户可能填出白名单外的值，筛选会静默回到默认）；`titleContains` ← `string`）；");
  l.push("- **值不可用时按「没给」处理**，绝不报错：视图永远打得开。但这几种写法会被校验器明确指出来（尤其是 `select` 的候选项不在白名单里——界面看着完全正常，筛选却永远按默认来，最阴的一种）；");
  l.push("- 查询字段的形态只有两种：**字面量**（`20` / `\"updated_desc\"`）或 **`{ \"fromSetting\": \"设置key\" }`**。写成别的（比如 `\"limit\": \"20\"`）会让整份 manifest 解析失败、插件被拒载——校验器会直接告诉你哪一项、该怎么写；");
  l.push("- **声明了设置却没有任何视图引用它** → 提醒（用户填了也不会改变任何东西）。");
  l.push("");
  l.push("完整可跑的零代码示例见 [`examples/plugins/reading-board/`](../examples/plugins/reading-board/)（一张浮层表 + 一个 `rail` 常驻面板 + 两个可调设置，没有一行 JS——两种落点都在里面）。");
  l.push("");
  l.push("## 4.10 主题插件（只出一组 token）");
  l.push("");
  l.push("主题插件也是**零代码**的：只声明一组设计变量，宿主把它们应用到界面上（停用即恢复）。");
  l.push("");
  l.push("```json");
  l.push('"theme": { "name": "暖色夜晚", "tokens": {');
  l.push('  "--bg": "#1b1714", "--text": "#efe6dd", "--accent": "#e0956a"');
  l.push("} }");
  l.push("```");
  l.push("");
  l.push("可覆盖的变量（**只含外观**；布局度量刻意不在内——让插件改列宽页宽会砸掉版面）：");
  l.push("");
  l.push("| 变量 | 类型 | 说明 |");
  l.push("|---|---|---|");
  for (const t of reg.theme.tokens) l.push(`| \`${t.name}\` | ${t.kind} | ${t.desc} |`);
  l.push("");
  l.push("几条规则：");
  l.push("");
  l.push("- **值里不允许出现 `url(` / `@` / 分号 / 花括号等**：这些变量会被写进页面样式，");
  l.push("  一个 `url(` 就足以让它对外发请求（本项目「绝不跟踪」的承诺不允许这种口子）；");
  l.push("- 同一个变量**只会有一个插件生效**：多个主题插件同时启用时按插件 id 排序取第一个，");
  l.push("  插件面板会明确提示冲突（而不是「看谁最后加载」这种不确定行为）；");
  l.push("- 停用插件即恢复你的主题（值只在启用期间应用，不写进任何配置文件）；");
  l.push("- 白名单外的变量改了没用，校验器会告诉你哪些名字不认识。");
  l.push("");
  l.push("## 4.11 导入触发（manifest 声明 + 宿主读文件）");
  l.push("");
  l.push("想让用户「选一个文件 → 你的命令拿到它的内容」，在 manifest 里声明 `triggers`：");
  l.push("");
  l.push("```json");
  l.push('"triggers": [');
  l.push('  { "kind": "import", "extensions": [".md", ".csv"], "command": "my-plugin.importMd" }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("```js");
  l.push("register({");
  l.push('  id: "my-plugin.importMd",');
  l.push('  title: "把选中的文件读一遍",');
  l.push("  run: function (args) {");
  l.push("    // args.fileName —— 用户选中的**文件名**（不含目录）");
  l.push("    // args.content  —— 文件内容（宿主读的，插件没有任何文件权限）");
  l.push('    return args.fileName + "：" + args.content.length + " 字符";');
  l.push("  }");
  l.push("});");
  l.push("```");
  l.push("");
  l.push("| kind | 说明 | 宿主是否已实现 |");
  l.push("|---|---|---|");
  for (const t of reg.triggers) l.push(`| \`${t.id}\` | ${t.title}：${t.desc} | ${t.hosted ? "✅ 已实现" : "⏳ 还没做"} |`);
  l.push("");
  l.push("几条必须知道的规则：");
  l.push("");
  l.push("- **读文件的是宿主，不是插件**：插件仍然没有文件读写能力，内容只是**这一次调用的入参**；");
  l.push("  插件要产出笔记依旧只能走 `api.*`（写能力照样出草稿、照样要用户确认）——触发方式不改变这条链路；");
  l.push("- 入口出现在命令面板里（「导入：用「插件名」打开 .md」）：点击 → 选文件 → 读内容 → 执行你的命令；");
  l.push("  **用户取消选择就不执行**（不会拿空内容去跑一次）；");
  l.push("- `extensions` 怎么写都会被规范化成 `.md` 这种**小写带点**形式（`\"MD\"` / `\".MD\"` 都等于 `.md`）；");
  l.push("  空数组或不合法的项（含空格 / 斜杠 / 目录分隔符）会被忽略，校验器会明确提醒；");
  l.push("- 触发只能调用**你自己注册的命令**：命令 id 写错或忘了 `register` 会提醒——");
  l.push("  否则用户点下去只会看到「命令不存在」；");
  l.push("- 命令如果还声明了 `params`，**导入触发不会渲染参数表单**（入参就是 `{ fileName, content }`）；");
  l.push("- 一次调用携带的内容有**体积上限**（1 MiB）：这条通道是「够装常见文本 / 表格文件」的行为界，");
  l.push("  不是「参数必须是短值」——但它也**不是数据通道**，插件要读笔记数据仍然只能用 `api.*`；");
  l.push("- `title` 不写就用默认的「导入：用「插件名」打开 .md」。");
  l.push("");
  l.push("### 4.11.1 导出（把内容保存成文件）");
  l.push("");
  l.push("反过来也成立：插件可以**产出**一个文件。用 `api.files.export(fileName, content)`：");
  l.push("");
  l.push("```js");
  l.push("register({");
  l.push('  id: "my-plugin.exportMd",');
  l.push('  title: "把当前页导出成 Markdown",');
  l.push("  run: function () {");
  l.push('    var page = api.page.current();          // 只读能力，需要 read:page.current');
  l.push('    api.files.export("导出.md", String(page));');
  l.push('    return "已准备好导出";');
  l.push("  }");
  l.push("});");
  l.push("```");
  l.push("");
  l.push("```json");
  l.push('"permissions": [');
  l.push('  { "id": "export:files", "reason": "把导出的内容保存成文件（存哪里由你选）" }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("几条关键规则：");
  l.push("");
  l.push("- **它不直接写盘**：`api.files.export(...)` 只是**登记**一次导出请求，命令跑完后宿主**逐个弹系统保存对话框**——用户点「保存」才写，点取消就什么都没写。和写笔记一样是「插件申请、用户决定」；");
  l.push("- **你给不出路径**：`fileName` 只是**建议的文件名**（目录部分会被去掉、长度会被截断），存到哪里由用户在对话框里定。所以这条能力不是「写任意路径」——它没有那个自由度，也就没有那个风险；");
  l.push("- **返回的 `{queued: true}` 不代表已保存**（它只说明请求被登记了）。保存对话框在插件跑完之后才弹，那时你的代码已经结束了——所以不要用它来判断「保存成功」；");
  l.push("- 上限：**单个文件 4 MiB、一次运行最多 4 个文件**（超了会抛错，你可以在 JS 里 `try/catch` 之后改写错误提示）。同名文件只保留第一次登记的那一份；");
  l.push("- **事件里无效**：事件（`on(...)`）触发时没有保存对话框可弹，导出请求会被忽略并写进插件日志；");
  l.push("- 需要权限 `export:files`（能力注册表里的写能力，风险等级 medium）。用户在安装/启用时看到的是「把内容保存成文件」，理由里会写清**导出的文件是明文**——它落在笔记之外，不随空间的加密一起保护。这一点请你在 `permissions[].reason` 里如实说，别让用户以为导出件也受加密保护。");
  l.push("");
  l.push("配合 `kind: \"export\"` 的触发声明，用户还能在命令面板里直接看到「导出：用「插件名」保存为 .md」：");
  l.push("");
  l.push("```json");
  l.push('"triggers": [');
  l.push('  { "kind": "export", "extensions": [".md"], "command": "my-plugin.exportMd" }');
  l.push("]");
  l.push("```");
  l.push("");
  l.push("## 5. 日志与提示");
  l.push("");
  l.push("- `api.log(message, level?)` —— 写日志，进插件日志环形缓冲（插件面板「日志」可查）。");
  l.push("  **插件运行时没有 `console`**，这是唯一的排错手段。");
  l.push("- `api.notify(message)` —— 给用户一句提示，执行结束后弹出。");
  l.push("");
  l.push("## 6. 沙箱里有什么、没有什么");
  l.push("");
  l.push("有：标准 JS 语言能力（`JSON` / `Math` / `Date` / `RegExp` / `Promise` …）与上表的 `api.*`。");
  l.push("");
  l.push("**没有**（这是刻意的，也是本体系安全的唯一来源）：`fetch` / `XMLHttpRequest` / `require` /");
  l.push("`process` / `window` / `document` / `localStorage` / Tauri `invoke` / 任意文件读写。");
  l.push("这些在沙箱里都是 `undefined`，且有回归测试钉住。");
  l.push("");
  l.push("## 7. 执行预算与错误");
  l.push("");
  l.push("每次执行都有硬预算，超限会失败并给出可见错误，**不会拖垮应用**：");
  l.push("");
  l.push("- 循环迭代：命令执行 1e6 次、插件加载 1e5 次（循环同时是「分配循环」的实际内存上限）；");
  l.push("- 墙钟：命令 5s、加载 3s；");
  l.push("- 内存：64 MiB 峰值（超出只终结该次调用）；");
  l.push("- 递归：256 层。");
  l.push("");
  l.push("错误码：");
  l.push("");
  l.push("| 错误码 | 含义 |");
  l.push("|---|---|");
  for (const e of reg.errorCodes) l.push(`| \`${e.code}\` | ${e.desc} |`);
  l.push("");
  l.push("## 8. 兼容与老写法");
  l.push("");
  l.push("API v1 冻结的是 `api.*` 这套名字。下列老全局名**仅为兼容已装在磁盘上的插件**而保留，");
  l.push("新插件不要使用（它们的语义与命名并不一致，例如 `__pages()` 返回的是**数量**）：");
  l.push("");
  l.push("| 老写法 | 等价能力 |");
  l.push("|---|---|");
  for (const g of reg.legacyGlobals) l.push(`| \`${g.global}\` | \`${g.capability}\` |`);
  l.push("");
  l.push("另外：**没写 `permissions` 的老 manifest** 会被授予 v1 基线权限（上表三项）并记录一条警告日志，");
  l.push("以便老插件升级后仍可用；新插件请显式声明。");
  l.push("");
  l.push("## 9. 开发循环：写 → 校验 → 看日志");
  l.push("");
  l.push("插件目录就是你的工程目录，没有编译步骤（宿主直接读 `main.js`）。改完文件后：");
  l.push("");
  l.push("1. **应用内自动重扫**：插件面板打开时，插件目录一变就会自动重新加载（面板标题会显示");
  l.push("   「已自动重新扫描 …」）——命令面板里的命令、行为、日志随即是新的，不用重启应用。");
  l.push("2. **点「校验」**：列出这个插件**全部**问题（不是只报第一个）：manifest 字段、权限与理由、");
  l.push("   JS 语法（用宿主同一个 Boa 引擎解析）、能不能注册出命令。校验通过 = 应用能装能跑。");
  l.push("3. **看「日志」与「活动」**：`api.log(...)` 的输出去「日志」；插件调用过哪些能力、");
  l.push("   有没有被权限拦下，去「活动」（被拒的调用同样留痕）。");
  l.push("");
  l.push("在仓库里开发（或接 CI）时，命令行也有一份**对照检查**：");
  l.push("");
  l.push("```bash");
  l.push("pnpm plugin:validate <插件目录>          # 校验 manifest / 权限与理由 / API 版本 / JS 语法");
  l.push("pnpm check:examples                      # 用类型包对示例插件做 tsc 类型检查");
  l.push("```");
  l.push("");
  l.push("> JS 语法在命令行由 V8 检查，而应用里跑的是 Boa——两者对新语法的宽容度可能不同。");
  l.push("> **最终以应用内「校验」为准**（它走的是与加载器完全同一条路径）。");
  l.push("");
  l.push("编辑器里想要补全与类型检查，把类型包加进 tsconfig（脚本式插件用 `globals.d.ts`）：");
  l.push("");
  l.push("```json");
  l.push("{");
  l.push('  "compilerOptions": {');
  l.push('    "allowJs": true, "checkJs": true, "noEmit": true, "strict": true,');
  l.push('    "paths": { "@shuyonote/plugin-types": ["<仓库>/packages/plugin-types/index.d.ts"] }');
  l.push("  },");
  l.push('  "files": ["<仓库>/packages/plugin-types/globals.d.ts"],');
  l.push('  "include": ["main.js"]');
  l.push("}");
  l.push("```");
  l.push("");
  l.push("仓库里 `examples/plugins/` 有三个可直接抄的示例（只读、写草稿、插件私有数据各一），");
  l.push("它们同时被 CI 用作者 CLI 与类型检查钉住——所以示例永远是可用的。");
  l.push("");
  return l.join("\n");
}

/**
 * AI 工具元数据（由注册表里 `ai: true` 的能力生成）。
 *
 * 生成的是**元数据**（id / 描述 / 参数 schema / 是否写操作）；**实现**在前端的
 * 适配表 `src/lib/capabilities/frontend.ts` 里，由门禁校验覆盖。
 * 这样 AI 宿主与插件消费的是同一份能力定义，仓库里不再有第二套语义工具清单。
 */
export function genAiTools(reg) {
  const tsType = (t) => ({ string: "string", number: "number", boolean: "boolean" })[t] ?? "string";
  const tools = reg.capabilities.filter((c) => c.ai);
  const l = [];
  l.push(`// ${HEADER}`);
  l.push("// 这里是**元数据**；实现见 src/lib/capabilities/frontend.ts（门禁校验覆盖）。");
  l.push("");
  l.push("/** 一个暴露给 AI 宿主的能力（= 注册表里 ai:true 的条目）。 */");
  l.push("export interface AiCapabilityMeta {");
  l.push("  id: string;");
  l.push("  description: string;");
  l.push("  argsSchema: {");
  l.push('    type: "object";');
  l.push("    properties: Record<string, { type: string; enum?: string[]; description?: string }>;");
  l.push("    required: string[];");
  l.push("  };");
  l.push("  isWrite: boolean;");
  l.push("}");
  l.push("");
  l.push("export const AI_TOOL_META: AiCapabilityMeta[] = [");
  for (const c of tools) {
    const props = (c.args ?? [])
      .map((a) => {
        const bits = [`type: ${JSON.stringify(tsType(a.type))}`];
        if (a.enum) bits.push(`enum: ${JSON.stringify(a.enum)}`);
        return `      ${JSON.stringify(a.name)}: { ${bits.join(", ")} },`;
      })
      .join("\n");
    const required = (c.args ?? []).filter((a) => a.required !== false).map((a) => JSON.stringify(a.name));
    l.push("  {");
    l.push(`    id: ${JSON.stringify(c.id)},`);
    l.push(`    description: ${JSON.stringify(c.desc ?? c.title)},`);
    l.push("    argsSchema: {");
    l.push('      type: "object",');
    l.push("      properties: {");
    if (props) l.push(props);
    l.push("      },");
    l.push(`      required: [${required.join(", ")}],`);
    l.push("    },");
    l.push(`    isWrite: ${c.kind === "write"},`);
    l.push("  },");
  }
  l.push("];");
  l.push("");
  return l.join("\n");
}

export function genPackageJson(reg) {
  return (
    JSON.stringify(
      {
        name: "@shuyonote/plugin-types",
        version: reg.apiVersion,
        description: "ShuyoNote 插件 API 类型定义（由 capabilities/capabilities.json 生成）",
        types: "index.d.ts",
        files: ["index.d.ts", "globals.d.ts"],
        license: "AGPL-3.0",
        private: true,
      },
      null,
      2,
    ) + "\n"
  );
}

export function buildAll(reg = loadRegistry()) {
  return {
    [OUTPUTS.shim]: genShim(reg),
    [OUTPUTS.rust]: genRust(reg),
    [OUTPUTS.types]: genTypes(reg),
    [OUTPUTS.globals]: genGlobals(reg),
    [OUTPUTS.themeMeta]: genThemeMeta(reg),
    [OUTPUTS.pkg]: genPackageJson(reg),
    [OUTPUTS.docs]: genDocs(reg),
    [OUTPUTS.aiTools]: genAiTools(reg),
    [OUTPUTS.menusMeta]: genMenusMeta(reg),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const check = process.argv.includes("--check");
  const files = buildAll();
  const stale = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    if (check) {
      const cur = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      // 行尾无关比较（Windows 检出常是 CRLF；见 .gitattributes）
      const norm = (x) => (x === null ? null : x.replace(/\r\n/g, "\n"));
      if (norm(cur) !== norm(content)) stale.push(rel);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      console.log(`  ✓ ${rel}`);
    }
  }
  if (check) {
    if (stale.length) {
      console.error("生成物与 capabilities/capabilities.json 不一致：");
      for (const f of stale) console.error(`  ✗ ${f}`);
      console.error("请跑：node scripts/gen-capabilities.mjs");
      process.exit(1);
    }
    console.log(`能力注册表生成物一致：${Object.keys(files).length} 个文件`);
  } else {
    console.log(`能力注册表已生成：${Object.keys(files).length} 个文件`);
  }
}
