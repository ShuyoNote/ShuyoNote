// 能力注册表的代码生成器（单一事实源 → 四处生成物）。
//
// 源：capabilities/capabilities.json
// 生成：
//   1. capabilities/plugin-api-shim.js      —— 插件看到的 `api.*`（唯一 ABI 面）
//   2. src-tauri/src/capabilities_gen.rs    —— Rust 绑定表（id → 权限 / scope / 实现函数名）
//   3. packages/plugin-types/index.d.ts     —— 作者用的类型包 @shuyonote/plugin-types
//   4. docs/plugin-api.md                   —— 面向作者的 API 文档
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
  pkg: "packages/plugin-types/package.json",
  docs: "docs/plugin-api.md",
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
  l.push("/** 插件命令：`register(...)` 注册后出现在命令面板（Ctrl+K）。 */");
  l.push("export interface PluginCommand {");
  l.push("  id: string;");
  l.push("  title: string;");
  l.push("  description?: string;");
  l.push("  /** 执行后关闭命令面板（适合跳转类命令）。 */");
  l.push("  closeOnRun?: boolean;");
  l.push("  /** 返回值会显示在命令面板底部；抛错会被宿主转成可见错误。 */");
  l.push("  run: () => string | void;");
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
          return `${doc.join("\n")}\n${pad}${key}(${params}): ${tsType(val.returns?.type ?? "void")};`;
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
  l.push("- `id` 必须**等于目录名**，且只能是小写字母、数字与 `-`；");
  l.push("- `main` 只能是同级文件名（`main.js` 或 `./main.js`）；");
  l.push("- 每次执行都会**重新 eval** 插件代码并新建一个沙箱 —— 不要在顶层做耗时工作；");
  l.push("- 返回的字符串会显示在命令面板底部；`closeOnRun: true` 执行后关闭面板。");
  l.push("");
  l.push("## 2. manifest 字段");
  l.push("");
  l.push("| 字段 | 必填 | 说明 |");
  l.push("|---|---|---|");
  l.push("| `id` | ✅ | 插件 id，必须等于目录名；单段 `[a-z0-9-]` |");
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
        files: ["index.d.ts"],
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
    [OUTPUTS.pkg]: genPackageJson(reg),
    [OUTPUTS.docs]: genDocs(reg),
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
      if (cur !== content) stale.push(rel);
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
