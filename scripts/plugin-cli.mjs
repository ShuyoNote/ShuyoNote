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
function checkDeclarativeViews(m, push, knownColumns, knownSorts, knownKinds, dirName) {
  const views = Array.isArray(m.views) ? m.views : [];
  if (views.length === 0) {
    push("error", "declarative_no_views", "声明式插件必须声明至少一个 views：它没有代码，视图就是它唯一的产出");
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
    const q = v.query ?? {};
    if (q.kind !== undefined && !knownKinds.has(q.kind)) push("warning", "view_bad_kind", `视图 ${v.id} 的 query.kind「${q.kind}」不认识（可用：${[...knownKinds].join(" / ")}）`);
    if (q.sort !== undefined && !knownSorts.has(q.sort)) push("warning", "view_bad_sort", `视图 ${v.id} 的 query.sort「${q.sort}」不认识（可用：${[...knownSorts].join(" / ")}）`);
    if (q.limit !== undefined && (typeof q.limit !== "number" || q.limit < 1 || q.limit > 500)) {
      push("warning", "view_bad_limit", `视图 ${v.id} 的 query.limit 超出范围（1–500）`);
    }
  }
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
      checkDeclarativeViews(m, push, knownColumns, knownSorts, knownKinds, dirName, resolve(dir));
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
        ["settings", "declarative_has_settings", "声明式插件没有代码去读设置"],
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
    console.log(`  ${color("零代码插件", "dim")}（runtime=declarative）：${views.length} 个视图，由宿主渲染，不申请任何权限`);
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
