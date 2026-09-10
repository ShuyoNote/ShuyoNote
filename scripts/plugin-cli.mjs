// 插件作者 CLI（`pnpm plugin:validate <插件目录>`）。
//
// 定位：**编辑器/CI 里的快速检查**，让作者在提交前就知道哪里不合规。它不是权威——
// JS 语法在这里由 V8 检查，而应用里跑的是 Boa；两边对「新语法」的宽容度可能不同。
// 权威始终是应用内的「验证」（`plugin_validate`），它走的是与加载器**同一条**路径
// （同一个 manifest 解析、同一个 Boa、同一次命令 discovery）。两者都通过，才是真的没问题。
//
// 之所以敢做这个 CLI：权限清单、API 版本这些**会真正影响运行**的事实全部来自
// `capabilities/capabilities.json`（与 Rust 侧同一个源），所以「CLI 说没问题、
// 应用却拒载」不会发生在这些项上。
//
// 用法：
//   node scripts/plugin-cli.mjs validate examples/plugins/daily-note
//   node scripts/plugin-cli.mjs validate <目录> --json      # 机器可读（CI 用）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import vm from "node:vm";
import { loadRegistry } from "./gen-capabilities.mjs";

const ESC = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m" };
const color = (s, c) => (process.stdout.isTTY ? `${ESC[c]}${s}${ESC.reset}` : s);

/**
 * 声明式（零代码）插件的检查：与 Rust 侧 `validate_declarative` 一一对应。
 * 列/排序/取值写错只是**提醒**（宿主会忽略并按默认来），但没有 views 是**错误**——
 * 那样的插件装上去什么都不会显示。
 */
function checkDeclarativeViews(m, push, knownColumns, knownSorts, knownKinds, themeTokenNames) {
  const views = Array.isArray(m.views) ? m.views : [];
  const themeTokens = m.theme && typeof m.theme === "object" && m.theme.tokens && typeof m.theme.tokens === "object" ? Object.keys(m.theme.tokens) : [];
  if (views.length === 0 && themeTokens.length === 0) {
    push("error", "declarative_no_views", "声明式插件必须声明 views 或 theme 之一：它没有代码，视图或主题就是它唯一的产出");
  }
  if (themeTokens.length > 0) {
    const known = new Set(themeTokenNames);
    for (const name of themeTokens) {
      if (!known.has(name)) push("warning", "theme_unknown_token", `主题变量 ${name} 不在白名单里（宿主只应用外观类变量）`);
    }
  }
  if (views.length > 8) push("warning", "too_many_views", `声明了 ${views.length} 个视图（上限 8）`);
  const seen = new Set();
  for (const v of views) {
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id) {
      push("error", "view_no_id", "views 里有一项没有 id");
      continue;
    }
    if (seen.has(v.id)) push("warning", "view_duplicate", `视图 id 重复：${v.id}`);
    seen.add(v.id);
    if (typeof v.title !== "string" || !v.title.trim()) push("warning", "view_no_title", `视图 ${v.id} 没有 title（菜单里会显示成 id）`);
    const cols = Array.isArray(v.columns) ? v.columns : [];
    if (cols.length === 0) push("warning", "view_no_columns", `视图 ${v.id} 没有声明 columns（会只显示标题）`);
    for (const c of cols) {
      if (!knownColumns.has(c)) {
        push("warning", "view_unknown_column", `视图 ${v.id} 声明了宿主不支持的列「${c}」（可用：${[...knownColumns].join(" / ")}）`);
      }
    }
    // 白名单只对**字面量**判定：`{ fromSetting }` 形态由 checkViewParams 判定（它要看设置声明的类型与候选项）
    const q = v.query ?? {};
    if (isLiteralField(q.kind) && !knownKinds.has(q.kind)) push("warning", "view_bad_kind", `视图 ${v.id} 的 query.kind「${q.kind}」不认识（可用：${[...knownKinds].join(" / ")}）`);
    if (isLiteralField(q.sort) && !knownSorts.has(q.sort)) push("warning", "view_bad_sort", `视图 ${v.id} 的 query.sort「${q.sort}」不认识（可用：${[...knownSorts].join(" / ")}）`);
    if (isLiteralField(q.limit) && (q.limit < 1 || q.limit > 500)) {
      push("warning", "view_bad_limit", `视图 ${v.id} 的 query.limit 超出范围（1–500）`);
    }
  }
}

/**
 * 查询字段的两种拼写都收（与 Rust 侧一致）：manifest 的正规写法是 camelCase
 * （`titleContains` / `updatedWithinDays`，与 `apiVersion` / `fromSetting` 一致），
 * snake_case 是照结构体反推出来的形态，应用侧用 `alias` 一并收下。
 * 检查前统一成 camelCase，避免"应用能用、CLI 却按没写处理"。
 */
function normalizeViewQuery(q) {
  if (!q || typeof q !== "object") return {};
  const out = { ...q };
  if (out.titleContains === undefined && out.title_contains !== undefined) out.titleContains = out.title_contains;
  if (out.updatedWithinDays === undefined && out.updated_within_days !== undefined) out.updatedWithinDays = out.updated_within_days;
  return out;
}

/** 查询字段是不是字面量（不是 `{ fromSetting }` 形态、也不是缺失）。 */
function isLiteralField(f) {
  return f !== undefined && (typeof f === "string" || typeof f === "number");
}

/** 查询字段里的设置引用 key（不是 `{ fromSetting }` 形态则 null）。 */
function settingRef(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  return typeof f.fromSetting === "string" && f.fromSetting.trim() ? f.fromSetting.trim() : null;
}

/**
 * 视图参数的检查：与 Rust 侧 `check_view_params` 一一对应（只跑声明式这一档）。
 *
 * 三件事：**引用的设置必须存在**（错误）、**类型必须能产出这个字段要的值**（错误）、
 * `select` 的候选项必须在白名单里 / 是数字（错误）——最后这条最阴：界面看着完全正常，
 * 只是筛选永远按默认来。
 */
function checkViewParams(m, push, knownSorts, knownKinds) {
  const views = Array.isArray(m.views) ? m.views : [];
  const decls = Array.isArray(m.settings) ? m.settings : [];
  const settings = new Map(
    decls
      .filter((d) => d && typeof d.key === "string")
      .map((d) => [
        d.key,
        {
          type: typeof d.type === "string" && d.type ? d.type : "string",
          options: (Array.isArray(d.options) ? d.options : []).map((o) =>
            typeof o === "string" ? o : typeof o?.value === "string" ? o.value : "",
          ),
        },
      ]),
  );
  const used = new Set();
  const shapes = [
    ["limit", "number", null],
    ["updatedWithinDays", "number", null],
    ["kind", "enum", knownKinds],
    ["sort", "enum", knownSorts],
    ["titleContains", "text", null],
  ];
  for (const [i, v] of views.entries()) {
    const q = normalizeViewQuery(v?.query);
    for (const [field, shape, allowed] of shapes) {
      const key = settingRef(q[field]);
      if (!key) continue;
      const decl = settings.get(key);
      if (!decl) {
        push("error", "view_param_unknown_setting", `views[${i}].query.${field} 引用了设置「${key}」，但 manifest.settings 里没有这一项——这条参数永远不会生效`);
        continue;
      }
      used.add(key);
      const shapeName = shape === "number" ? "数字" : shape === "enum" ? "白名单里的值" : "文本";
      if (shape === "number" && (decl.type === "number" || decl.type === "select")) {
        if (decl.type === "select") {
          const bad = decl.options.filter((o) => !(o.trim() !== "" && Number.isFinite(Number(o))));
          if (bad.length) {
            push("error", "view_param_bad_options", `views[${i}].query.${field} 用设置「${key}」取值，但它是 select、候选项里有不是数字的：${bad.map((s) => `「${s}」`).join("、")}`);
          }
        }
      } else if (shape === "enum" && (decl.type === "select" || decl.type === "string")) {
        if (decl.type === "select") {
          const bad = decl.options.filter((o) => !allowed.has(o));
          if (bad.length) {
            push("error", "view_param_bad_options", `views[${i}].query.${field} 用设置「${key}」取值，但它的候选项不在白名单里：${bad.map((s) => `「${s}」`).join("、")}（可用：${[...allowed].join(" / ")}）——用户选哪个都会被忽略，界面看着正常、筛选却永远按默认来`);
          }
        } else {
          push("warning", "view_param_string_source", `views[${i}].query.${field} 由文本设置「${key}」驱动：用户填出白名单外的值（可用：${[...allowed].join(" / ")}）时这条参数会被忽略，筛选会静默回到默认——建议改成 select`);
        }
      } else if (shape === "text" && (decl.type === "string" || decl.type === "select")) {
        // 文本字段什么都能塞，不必再说
      } else if (shape === "number" && decl.type === "string") {
        push("warning", "view_param_string_source", `views[${i}].query.${field} 由文本设置「${key}」驱动：用户填的不是数字时这条参数会被忽略（视图退回默认）——建议把设置的 type 改成 number`);
      } else {
        push("error", "view_param_bad_type", `views[${i}].query.${field} 需要${shapeName}，但设置「${key}」的 type 是「${decl.type}」——它永远产不出可用的值，这条参数等于白写`);
      }
    }
  }
  for (const key of settings.keys()) {
    if (!used.has(key)) {
      push("warning", "declarative_setting_unused", `设置「${key}」没有被任何视图用到：声明式插件没有代码去读设置，所以用户填了它也不会改变任何东西（要么让某个视图 query 用 {"fromSetting": "${key}"} 引用它，要么删掉它）`);
    }
  }
}

/**
 * 视图查询字段的**取值形态**检查（看原始 JSON）。
 *
 * 为什么必须单独看形态：字段是 `字面量 | { fromSetting }` 的联合，写成 `"limit": "20"`
 * 会让**整份 manifest 解析失败**（应用会直接拒载），而只报"必须声明 views"会把作者引向
 * 反方向——他明明写了。
 */
function checkViewFieldShapes(m, push) {
  const views = Array.isArray(m.views) ? m.views : [];
  const fields = [
    ["limit", true],
    ["updatedWithinDays", true],
    ["kind", false],
    ["sort", false],
    ["titleContains", false],
  ];
  for (const [i, v] of views.entries()) {
    if (!v?.query || typeof v.query !== "object") continue;
    const q = normalizeViewQuery(v.query);
    for (const [field, numeric] of fields) {
      const raw = q[field];
      if (raw === undefined) continue;
      if (settingRef(raw)) continue;
      if (numeric ? Number.isInteger(raw) : typeof raw === "string") continue;
      push("error", "view_field_shape", `views[${i}].query.${field} 的写法不对：只能是${numeric ? "数字" : "字符串"}，或指向一个设置 {"fromSetting": "设置key"}——形态不对会让整份 manifest 解析失败、插件被拒载`);
    }
  }
}


/**
 * 导入触发的检查：与 Rust 侧 `check_triggers_declaration` 一一对应（两档插件都跑）。
 *
 * 严重度与那边一致：**kind 不认识 / 没有 command → 错误**（用户点了必然没反应），
 * **extensions 为空或不合法 → 提醒**（宿主会忽略，插件本身装得上）。
 *
 * 这里**刻意不查**「command 是否真的注册了」：那要跑一遍 discovery，而 CLI 只做 V8 语法
 * 检查（见文件头：权威始终是应用内的「验证」）。所以这条只有应用内验证会报。
 */
function checkTriggers(m, push, knownTriggerKinds) {
  const triggers = m.triggers;
  if (triggers === undefined) return;
  if (!Array.isArray(triggers)) {
    push("error", "trigger_not_array", "manifest.triggers 必须是数组：[{ kind, extensions, command }]");
    return;
  }
  if (triggers.length > 4) push("warning", "trigger_too_many", `声明了 ${triggers.length} 条导入触发（上限 4）`);
  const known = [...knownTriggerKinds.keys()];
  triggers.forEach((t, i) => {
    const at = `triggers[${i}]`;
    const kind = t && typeof t.kind === "string" ? t.kind.trim() : "";
    const command = t && typeof t.command === "string" ? t.command.trim() : "";
    if (!knownTriggerKinds.has(kind)) {
      push("error", "trigger_unknown_kind", `${at} 的 kind「${kind}」不认识（本版本支持：${known.join(" / ")}）：宿主不会为它加入口`);
    } else if (!knownTriggerKinds.get(kind)) {
      // 注册表认识、宿主还没接：与 Rust 侧同样是提醒（写了现在也不会出现）
      push("warning", "trigger_not_hosted", `${at} 的 kind「${kind}」本版本还没有宿主入口：写了现在也不会出现`);
    }
    if (!command) {
      push("error", "trigger_no_command", `${at} 没有 command：触发要把文件交给一个命令（或让命令产出内容），没写就等于让用户点了没反应`);
    }
    // 导出触发会调 api.files.export：显式声明了权限却没写 export:files 时，点了只会看到权限不足
    if (kind === "export" && Array.isArray(m.permissions) && !m.permissions.some((p) => p?.id === "export:files")) {
      push("warning", "trigger_export_without_permission", `${at} 是导出触发，但 manifest.permissions 里没有「export:files」：命令里调 api.files.export 会被拒（要么补上这项权限，要么删掉这条触发）`);
    }
    const exts = t ? t.extensions : undefined;
    if (!Array.isArray(exts) || exts.length === 0) {
      push("warning", "trigger_no_extensions", `${at} 没有声明 extensions：宿主不知道该在哪些文件上出现这个入口（例如 [".md", ".csv"]）`);
      return;
    }
    for (const e of exts) {
      if (normalizeExtension(e) === null) {
        push("warning", "trigger_bad_extension", `${at} 的扩展名「${String(e)}」不合法（写成 .md 这样：小写、带点、一个扩展名）：这一项会被忽略`);
      }
    }
  });
}

/** 与 Rust `normalize_extension` 同一套规则：小写、带点、单个扩展名；不合法返回 null。 */
function normalizeExtension(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^\.+/, "").toLowerCase();
  if (!t || t.length > 16) return null;
  return /^[a-z0-9_-]+$/.test(t) ? `.${t}` : null;
}

/** 与 Rust `is_safe_plugin_id` 同一套规则（见 src-tauri/src/plugins.rs）。 */
function isSafeId(id) {
  if (!id || id === "." || id === "..") return false;
  if ([...id].every((c) => c === ".")) return false;
  if (id.endsWith(".")) return false;
  return /^[A-Za-z0-9_.-]+$/.test(id);
}

/** 与 Rust `is_bare_file_name` 同一套规则：同级文件名，不含路径分隔符，不是 `.`/`..`。 */
function isBareFileName(main) {
  if (!main || main.endsWith("/") || main.endsWith("\\")) return false;
  if (main === "." || main === "..") return false;
  if (main.includes("/") || main.includes("\\")) return false;
  return true;
}

const BIG_ENTRY_BYTES = 512 * 1024;

function validate(dirArg) {
  const dir = resolve(dirArg);
  const dirName = basename(dir);
  const problems = [];
  const push = (severity, code, message) => problems.push({ severity, code, message });

  const reg = loadRegistry();
  const knownPerms = new Map(reg.permissions.map((p) => [p.id, p]));
  const regMajor = String(reg.apiVersion).split(".")[0];

  // ---- manifest ----
  let raw = null;
  try {
    raw = readFileSync(join(dir, "manifest.json"), "utf8");
  } catch (e) {
    push("error", "manifest_missing", `读不到 manifest.json：${e.message}`);
  }
  let m = null;
  if (raw !== null) {
    try {
      m = JSON.parse(raw);
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        push("error", "manifest_json", "manifest.json 的顶层必须是一个对象");
        m = null;
      }
    } catch (e) {
      push("error", "manifest_json", `manifest.json 不是合法 JSON：${e.message}`);
    }
  }

  let id = "";
  let main = "main.js";
  let entries = [];
  const runtime = typeof m?.runtime === "string" && m.runtime ? m.runtime : "logic";
  if (runtime !== "logic" && runtime !== "declarative") {
    push("error", "runtime_unknown", `manifest.runtime 不认识：${runtime}（本应用支持 logic / declarative），会被拒载`);
  }
  const knownColumns = new Set([
    "title", "kind", "updated_at", "created_at", "days_since_update", "title_length",
  ]);
  const knownSorts = new Set(["updated_desc", "created_desc", "title_asc", "title_desc"]);
  const knownKinds = new Set(["any", "page", "database"]);
  // 主题白名单从注册表取（不 import 生成的 .ts：CI 的 Node 22 不支持直接 import TS）
  const themeTokenNames = new Set(((reg.theme && reg.theme.tokens) || []).map((x) => x.name));
  if (m) {
    id = typeof m.id === "string" ? m.id : "";
    if (!id) push("error", "id_missing", "manifest.id 缺失（每个插件必须有唯一 id）");
    else if (!isSafeId(id)) push("error", "id_unsafe", `id「${id}」不合法：只允许字母数字与 _ . -，且不得是 . / .. / 全点 / 以点结尾`);
    else if (id !== dirName) push("error", "id_mismatch", `manifest.id（${id}）必须等于目录名（${dirName}）`);

    if (typeof m.name !== "string" || !m.name.trim()) push("error", "name_missing", "manifest.name 缺失（界面上要显示它）");
    if (typeof m.version !== "string" || !m.version.trim()) push("warning", "version_missing", '建议写 manifest.version（如 "1.0.0"）');

    const api = typeof m.apiVersion === "string" ? m.apiVersion : "";
    if (!api) {
      push("warning", "api_version_missing", `建议显式声明 apiVersion（当前 API ${reg.apiVersion}），缺省按它处理`);
    } else if (api.split(".")[0] !== regMajor) {
      push("error", "api_version_unsupported", `apiVersion「${api}」的主版本不受支持（本应用支持 ${reg.apiVersion}）：主版本不认识会直接拒载`);
    }

    main = typeof m.main === "string" && m.main ? m.main : "main.js";
    if (runtime === "declarative") {
      // 零代码插件：没有 main.js、没有语法可查、也不需要权限（不去申请任何能力）。
      // 这里必须与 Rust 侧（plugin_validate.rs 的 validate_declarative）一致，
      // 否则作者 CLI 会把一个本来能用的零代码插件报成"装不上"。
      checkDeclarativeViews(m, push, knownColumns, knownSorts, knownKinds, themeTokenNames);
      // 视图参数（查询字段引用用户设置）：形态 → 引用 → 类型能不能对上。
      // 「加载器会不会拒」那一层兜底只有应用内验证有（CLI 不跑 Rust 的 manifest 解析）。
      checkViewFieldShapes(m, push);
      checkViewParams(m, push, knownSorts, knownKinds);
    } else if (!isBareFileName(main)) {
      push("error", "main_invalid", `manifest.main（${main}）必须是同级文件名：不得含路径分隔符，也不得是 . / ..`);
    } else {
      try {
        const st = statSync(join(dir, main));
        if (st.size === 0) push("error", "main_empty", `入口文件 ${main} 是空的`);
        else if (st.size > BIG_ENTRY_BYTES) {
          push("warning", "main_large", `入口文件 ${main} 有 ${(st.size / 1048576).toFixed(1)} MiB：插件应当是脚本，不是打包产物`);
        }
        entries = readdirSync(dir);
      } catch {
        push("error", "main_missing", `入口文件 ${main} 不存在`);
      }
    }

    // ---- 权限（与运行直接相关的事实全部来自注册表）----
    if (runtime === "declarative") {
      for (const [field, code, msg] of [
        ["permissions", "declarative_has_permissions", "声明式插件没有代码，manifest.permissions 不会被用到"],
        ["events", "declarative_has_events", "声明式插件没有代码，manifest.events 收不到任何事件"],
        ["triggers", "declarative_has_triggers", "声明式插件没有命令可以调用，manifest.triggers 不会接住任何文件（要导入触发就得写 logic 档）"],
        ["main", "declarative_has_main", "runtime=declarative 时 main.js 不会被读取或执行"],
      ]) {
        if (m[field] !== undefined) push("warning", code, msg);
      }
    } else if (m.permissions === undefined) {
      push("warning", "permissions_absent", `manifest 未声明 permissions：应用会按 v1 基线权限授权（${reg.permissions.length} 项），新插件请显式声明`);
    } else if (!Array.isArray(m.permissions)) {
      push("error", "permissions_invalid", "manifest.permissions 必须是数组：[{ id, reason }]");
    } else {
      const seen = new Set();
      for (const [i, d] of m.permissions.entries()) {
        if (!d || typeof d !== "object" || typeof d.id !== "string" || !d.id) {
          push("error", "permissions_invalid", `permissions[${i}] 必须形如 { "id": "...", "reason": "..." }`);
          continue;
        }
        if (seen.has(d.id)) push("warning", "permission_duplicate", `权限重复声明：${d.id}`);
        seen.add(d.id);
        if (!knownPerms.has(d.id)) {
          push("warning", "permission_unknown", `忽略未知权限 ${d.id}（API v${reg.apiVersion} 不认识它，装了也不会生效）`);
        }
        if (typeof d.reason !== "string" || !d.reason.trim()) {
          push("warning", "permission_no_reason", `权限 ${d.id} 没有写 reason（用户看不到它为什么要这项权限）`);
        }
      }
    }
  }

  // ---- 事件订阅（与 Rust 侧同一套判定：未知事件忽略 + 警告、缺 reason 警告）----
  const knownEvents = new Map((reg.events ?? []).map((e) => [e.id, e]));
  if (m) {
    if (m.events !== undefined && !Array.isArray(m.events)) {
      push("error", "events_invalid", "manifest.events 必须是数组：[{ on, reason }]");
    } else if (Array.isArray(m.events)) {
      const seen = new Set();
      for (const [i, d] of m.events.entries()) {
        if (!d || typeof d !== "object" || typeof d.on !== "string" || !d.on) {
          push("error", "events_invalid", `events[${i}] 必须形如 { "on": "...", "reason": "..." }`);
          continue;
        }
        if (seen.has(d.on)) push("warning", "event_duplicate", `事件重复声明：${d.on}`);
        seen.add(d.on);
        if (!knownEvents.has(d.on)) {
          push("warning", "event_unknown", `忽略未知事件 ${d.on}（API v${reg.apiVersion} 不认识它：声明了也收不到）`);
        }
        if (typeof d.reason !== "string" || !d.reason.trim()) {
          push("warning", "event_no_reason", `事件 ${d.on} 没有写 reason（用户看不到它为什么要常驻运行）`);
        }
      }
    }
  }

  // ---- 导入触发（与 Rust 侧 check_triggers_declaration 同源，两档都跑）----
  if (m) checkTriggers(m, push, new Map((reg.triggers ?? []).map((t) => [t.id, t.hosted])));

  // ---- JS 语法（V8；权威是应用内的 Boa）----
  const mainPath = join(dir, main);
  let source = null;
  try {
    source = readFileSync(mainPath, "utf8");
  } catch {
    /* 已在上面报过 main_missing */
  }
  if (source && runtime !== "declarative") {
    try {
      new vm.Script(source, { filename: main });
    } catch (e) {
      push("error", "syntax_error", `JS 语法错误（V8 解析失败）：${e.message}`);
    }
  }

  return { dir, dirName, manifest: m, id, main, source, problems, reg, knownPerms, knownEvents };
}

function report(r, json) {
  const errors = r.problems.filter((p) => p.severity === "error");
  const warnings = r.problems.filter((p) => p.severity === "warning");
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          dir: r.dirName,
          id: r.id,
          main: r.main,
          apiVersion: r.reg.apiVersion,
          permissions: (Array.isArray(r.manifest?.permissions) ? r.manifest.permissions : []).map((d) => ({
            id: d?.id ?? "",
            reason: d?.reason ?? "",
            known: r.knownPerms.has(d?.id),
            title: r.knownPerms.get(d?.id)?.title ?? "",
          })),
          events: (Array.isArray(r.manifest?.events) ? r.manifest.events : []).map((d) => ({
            on: d?.on ?? "",
            reason: d?.reason ?? "",
            known: r.knownEvents.has(d?.on),
            title: r.knownEvents.get(d?.on)?.title ?? "",
          })),
          // 扩展名在这里也按宿主的规则规范化，CI 才拿得到"用户实际会看到哪些入口"
          triggers: (Array.isArray(r.manifest?.triggers) ? r.manifest.triggers : []).map((t) => ({
            kind: t?.kind ?? "",
            command: t?.command ?? "",
            extensions: (Array.isArray(t?.extensions) ? t.extensions : []).map((e) => normalizeExtension(e)).filter(Boolean),
            known: new Set((r.reg.triggers ?? []).map((x) => x.id)).has(t?.kind),
          })),
          problems: r.problems,
        },
        null,
        2,
      ),
    );
    return errors.length === 0;
  }

  console.log(`${color("插件校验", "dim")} ${r.dir}`);
  const isDecl = (r.manifest?.runtime ?? "logic") === "declarative";
  console.log(`  id=${r.id || "(缺)"}  ${isDecl ? "runtime=declarative" : `main=${r.main}`}  API=${r.reg.apiVersion}`);

  const declarative = (r.manifest?.runtime ?? "logic") === "declarative";
  if (declarative) {
    const views = Array.isArray(r.manifest?.views) ? r.manifest.views : [];
    const themeCount = r.manifest?.theme?.tokens ? Object.keys(r.manifest.theme.tokens).length : 0;
    const parts = [];
    if (views.length > 0) parts.push(`${views.length} 个视图`);
    if (themeCount > 0) parts.push(`${themeCount} 个主题变量`);
    console.log(`  ${color("零代码插件", "dim")}（runtime=declarative）：${parts.join(" + ") || "无产出"}，由宿主渲染，不申请任何权限`);
    for (const v of views) {
      const cols = Array.isArray(v?.columns) ? v.columns.filter((c) => r.knownColumns?.has(c) ?? true) : [];
      console.log(`    ▦ ${v?.title || v?.id || "(无标题)"}  ${color(`列：${cols.join(" / ") || "标题"}`, "dim")}`);
    }
  }
  const declares = declarative ? [] : Array.isArray(r.manifest?.permissions) ? r.manifest.permissions : [];
  if (declares.length > 0) {
    console.log(`  ${color("权限清单", "dim")}（用户装的时候会看到这些）：`);
    for (const d of declares) {
      const p = r.knownPerms.get(d?.id);
      // 固定宽度的标记列：不认识的用 `?`（并在行尾说明），避免中文提示把表格撑歪
      const mark = p ? color("✓", "green") : color("?", "yellow");
      const risk = p ? `[${p.risk}]` : "";
      const reason = d?.reason?.trim() ? d.reason : color("（缺 reason）", "yellow");
      const tail = p ? "" : color("  ← 本版本不认识，装了也不生效", "yellow");
      console.log(`    ${mark} ${String(d?.id).padEnd(20)} ${risk.padEnd(9)} ${p?.title ?? ""} —— ${reason}${tail}`);
    }
  } else if (r.manifest && !declarative) {
    console.log(`  ${color("权限清单", "dim")}：未声明 → 应用会按 v1 基线权限授权（${r.reg.permissions.length} 项，等于全给）`);
  }

  const declaresEvents = Array.isArray(r.manifest?.events) ? r.manifest.events : [];
  if (declaresEvents.length > 0) {
    console.log(`  ${color("事件订阅", "dim")}（用户没点命令时也会跑代码，启用前会展示）：`);
    for (const d of declaresEvents) {
      const e = r.knownEvents.get(d?.on);
      const mark = e ? color("✓", "green") : color("?", "yellow");
      const reason = d?.reason?.trim() ? d.reason : color("（缺 reason）", "yellow");
      const tail = e ? "" : color("  ← 本版本不认识，收不到", "yellow");
      console.log(`    ${mark} ${String(d?.on).padEnd(16)} ${e?.title ?? ""} —— ${reason}${tail}`);
    }
  }

  const declaresTriggers = Array.isArray(r.manifest?.triggers) ? r.manifest.triggers : [];
  if (declaresTriggers.length > 0) {
    const knownTriggers = new Map((r.reg.triggers ?? []).map((t) => [t.id, t]));
    console.log(`  ${color("文件触发", "dim")}（命令面板里会多出这些入口）：`);
    for (const t of declaresTriggers) {
      const k = knownTriggers.get(t?.kind);
      const mark = k ? color("✓", "green") : color("?", "yellow");
      const exts = (Array.isArray(t?.extensions) ? t.extensions : []).map((e) => normalizeExtension(e)).filter(Boolean);
      const tail = k ? "" : color("  ← 本版本不认识这种触发", "yellow");
      console.log(`    ${mark} ${String(t?.kind ?? "").padEnd(10)} ${(exts.join(" / ") || color("（没有合法扩展名）", "yellow")).padEnd(18)} → ${t?.command ?? ""}${tail}`);
    }
  }

  for (const p of r.problems) {
    const mark = p.severity === "error" ? color("✗", "red") : color("!", "yellow");
    console.log(`  ${mark} [${p.code}] ${p.message}`);
  }
  if (errors.length === 0) {
    console.log(
      `  ${color("✓", "green")} 本地检查通过${warnings.length ? `（${warnings.length} 条提醒）` : ""}` +
        (isDecl ? "" : `　${color("JS 语法由 V8 检查，最终以应用内「验证」为准（Boa）", "dim")}`),
    );
  } else {
    console.log(`  ${color(`✗ ${errors.length} 个错误`, "red")}（${warnings.length} 条提醒）`);
  }
  return errors.length === 0;
}

const [cmd, target, ...flags] = process.argv.slice(2);
if (cmd !== "validate" || !target) {
  console.error("用法：node scripts/plugin-cli.mjs validate <插件目录> [--json]");
  process.exit(2);
}
process.exit(report(validate(target), flags.includes("--json")) ? 0 : 1);
