#!/usr/bin/env node
// check-im-boundary.mjs —— 企业版 IM（「讨论」）的**三条边界**判据（纯读源码 ⇒ **不需要 cargo** ✓）
//
// 规格：`docs/specs/2026-10-01-enterprise-im-spec.md` §1 的
//   `INV-IM-space-is-the-only-boundary` ／ `INV-IM-membership-is-the-only-relationship`
//   ／ `INV-IM-push-carries-no-body`
//
// 挡的是哪一类真实事故（incident）：
//   「讨论」是**长在空间上**的 ✓ —— 而"再开一条不经空间门的路"是**加出来的、不是改出来的** ✗，
//   它不需要动任何既有代码，**也不会让任何既有测试变红**：新写的那个 handler 忘了调 `require_space`，
//   功能全对、测试全绿，只是**权限边界上多了一个洞** ✗ ⇒ 只能靠这条静态判据盯住 ✓。
//   同理两条：① 推送帧里**顺手**加了标题（＝服务端开始"懂内容"✗）；
//   ② schema 里**顺手**加了 `friends` 表（＝出现"不属于任何空间"的两个人 ⇒ 权限边界被打穿 ✗）。
//
// 判据四条（**窄，且今天全绿** ✓）：
//   ① **空间是唯一边界**：`collab.rs` 里每个 handler 必须调 `require_space(`；
//      例外只许是**用户级**的 3 条通知 handler，且它们在 `main.rs` 里的路由**必须不在 `/spaces/` 下**
//      （⇒ 白名单**不能**被用来夹带一条空间级路由 ✓）
//   ② **推送不带正文**：`sync.rs::push_frame` 的函数体里不许出现内容类字段名，且**必须**带 `space_id` 与 `seq`
//   ③ **没有"好友"关系**：schema 里不许出现 friend／contact／follow／roster 一类表（且必须真解析到足够多的表）
//   ④ **客户端只认三种帧**：`sync_stream.rs::frame_kind` 的 `Some("<字面量>")` 分支只许是 `push`／`ping`，
//      且函数体不许引用内容类字段名
//
// 退出码：0 干净 ／ 1 有发现 ／ 2 服务端源码被显式要求但不在（`--require-server`，**不算通过**）
//   ⚠️ 服务端源码**不在**时（CI 上只检出客户端仓 ✓）⇒ **自报跳过（不装绿）** 并继续查客户端那半边 ✓
//      理由与 `check-mcp-host-authz` 同一套：跨仓的东西在 CI 上缺席是**常态**，判红会逼人绕开 ✓
// 用法：node scripts/check-im-boundary.mjs ／ --root <客户端仓根> ／ --server <服务端仓根>
//       ／ --require-server ／ --self-test

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

/** 内容类字段 —— 出现在**帧里**就是"服务端开始懂内容"✗
 *  ⚠️ 只认**引号里的字段名**（JSON 的字段名一定是字符串字面量 ✓）；
 *  裸词只留 `content_*` / `snapshot` / `snippet` / `full_text` 这几个**不可能是形参名**的 ✓
 *  —— 2026-10-01 第一版把裸 `payload` 也算，结果 `frame_kind(payload: &str)` 的**形参**当场假红 ✓ */
const CONTENT_FIELDS = ["body", "payload", "content_json", "content_text", "snapshot", "snippet", "full_text"];
const CONTENT_BARE = ["content_json", "content_text", "snapshot", "snippet", "full_text"];

/** 函数体里出现的"内容类字段"（去重；空＝干净 ✓） */
function contentHits(body) {
  const hits = new Set();
  for (const f of CONTENT_FIELDS) if (body.includes('"' + f + '"')) hits.add(f);
  for (const f of CONTENT_BARE) if (body.includes(f)) hits.add(f);
  return [...hits];
}

/** ⭐ 白名单：**用户级**的 3 条通知 handler（不是空间级 ⇒ 不调 `require_space` 是对的 ✓）
 *  ⚠️ 每一条都必须在 `main.rs` 里**真的是** `/notifications…` 路由 —— 由判据 ①b 逐个核 ✓
 *  ⚠️ 加名字之前先问：它是"我的通知"还是"这个空间的讨论"？后者**必须**回 `require_space` ✓ */
export const USER_LEVEL_HANDLERS = ["list_notifications", "seen_notification", "seen_all"];

/** 关系类表名 —— 出现即"出现了不属于任何空间的人"✗ */
const RELATION_TABLES = /^(friends?|contacts?|follows?|rosters?|buddies|connections)$/;

/** 取一个 Rust 顶层函数的**体**（从签名的第一个 `{` 之后算起 —— ⚠️ 别把**形参名**算进去 ✗：
 *  2026-10-01 本判据第一版就踩了这个 —— `frame_kind(payload: &str)` 的形参名 `payload`
 *  正好是内容类字段名 ⇒ **自测当场抓出"合规夹具也红"** ✓） */
function bodyOf(text, signatureRe) {
  const m = text.match(signatureRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const brace = after.indexOf("{");
  if (brace < 0) return null;
  const body = after.slice(brace + 1);
  const end = body.search(/\n\}\n/);
  return end < 0 ? body : body.slice(0, end);
}

/** 纯判据：一组源码文本（可为 null ＝ 不在）⇒ findings（空＝干净 ✓） */
export function judge({ collabRs, mainRs, syncRs, dbRs, frameKindRs }) {
  const out = [];

  // ── ① 空间是唯一边界 ──────────────────────────────────────────────
  /** 白名单里**真正存在**的那些 handler（⛔ 不存在的由 ① 的"白名单过期"报 ✓，①b 不再重复报 ✗） */
  let allowlisted = [];
  if (collabRs !== null) {
    const handlers = [...collabRs.matchAll(/pub\s+async\s+fn\s+([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1]);
    allowlisted = USER_LEVEL_HANDLERS.filter((w) => handlers.includes(w));
    if (handlers.length === 0) {
      out.push("✗ `collab.rs` 里一个 handler 都没解析到 ⇒ 判据**没检查到东西**（不算通过 ✗）");
    } else {
      const seen = new Set();
      for (const h of handlers) {
        const body = bodyOf(collabRs, new RegExp("pub\\s+async\\s+fn\\s+" + h + "\\s*\\("));
        seen.add(h);
        if (body && body.includes("require_space(")) continue;
        if (USER_LEVEL_HANDLERS.includes(h)) continue; // 由 ①b 交叉核 ✓
        out.push("✗ `collab.rs` 的 handler `" + h + "` 没调 `require_space(` ⇒ **它是一条不经空间门的路** ✗" +
          "（若它确实该是用户级的，把它登记进 `USER_LEVEL_HANDLERS` 并确认它的路由不在 `/spaces/` 下 ✓）");
      }
      for (const w of USER_LEVEL_HANDLERS) {
        if (!seen.has(w)) out.push("✗ 白名单里的 `" + w + "` 在 `collab.rs` 里**已经不存在** ⇒ 白名单过期了（删掉它 ✓）");
      }
    }
  }

  // ── ①b 白名单不许夹带空间级路由 ──────────────────────────────────
  if (mainRs !== null) {
    for (const w of allowlisted) {
      const re = new RegExp("\\.route\\(\\s*\"([^\"]+)\"\\s*,\\s*(?:get|post|put|delete|patch)\\(\\s*collab::" + w + "\\b");
      const m = mainRs.match(re);
      if (!m) {
        out.push("✗ 在 `main.rs` 里找不到 `collab::" + w + "` 的路由 ⇒ 白名单与路由对不上（判据没检查到东西 ✗）");
      } else if (m[1].startsWith("/spaces/")) {
        out.push("✗ 白名单里的 `" + w + "` 其实挂在 `" + m[1] + "` 下 ⇒ **空间级路由借白名单逃过了鉴权判据** ✗");
      }
    }
  }

  // ── ② 推送不带正文 ────────────────────────────────────────────────
  if (syncRs !== null) {
    const body = bodyOf(syncRs, /pub\s+fn\s+push_frame\s*\(/);
    if (body === null) {
      out.push("✗ 找不到 `sync.rs::push_frame` ⇒ 判据**没检查到东西**（不算通过 ✗）");
    } else {
      const bad = contentHits(body);
      if (bad.length) out.push("✗ `push_frame` 的帧里出现了内容类字段「" + bad.join("／") + "」⇒ 推送只许说有新消息（⛔ 不带正文）✗");
      for (const need of ["space_id", "seq"]) {
        if (!body.includes(need)) out.push("✗ `push_frame` 的帧里没有 `" + need + "` ⇒ 帧被改空了也照样\"过\" ✗（判据要正向锚 ✓）");
      }
    }
  }

  // ── ③ 没有"好友"关系 ─────────────────────────────────────────────
  if (dbRs !== null) {
    const tables = [...dbRs.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    const uniq = [...new Set(tables)];
    if (uniq.length < 15) {
      out.push("✗ 只解析到 " + uniq.length + " 张表（预期 ≥15）⇒ 判据**没检查到东西**（不算通过 ✗）");
    } else {
      const rel = uniq.filter((t) => RELATION_TABLES.test(t));
      if (rel.length) out.push("✗ schema 里出现了关系类表「" + rel.join("／") + "」⇒ ⛔ 人和人的关系**只有空间成员这一种** ✗");
    }
  }

  // ── ④ 客户端只认三种帧 ───────────────────────────────────────────
  if (frameKindRs !== null) {
    const body = bodyOf(frameKindRs, /pub\s+fn\s+frame_kind\s*\(/);
    if (body === null) {
      out.push("✗ 找不到 `sync_stream.rs::frame_kind` ⇒ 判据**没检查到东西**（不算通过 ✗）");
    } else {
      const arms = [...body.matchAll(/Some\("([^"]+)"\)/g)].map((m) => m[1]);
      const badArms = arms.filter((a) => a !== "push" && a !== "ping");
      if (badArms.length) out.push("✗ `frame_kind` 认了第三种帧「" + badArms.join("／") + "」⇒ 客户端开始解析讨论事件了 ✗（先把界定了再加 ✓）");
      if (!arms.includes("push") || !arms.includes("ping")) out.push("✗ `frame_kind` 少了 `push`／`ping` 分支 ⇒ 判据没检查到东西（不算通过 ✗）");
      const bad = contentHits(body);
      if (bad.length) out.push("✗ `frame_kind` 里出现了内容类字段「" + bad.join("／") + "」⇒ 帧解析不许碰内容 ✗");
    }
  }

  return out;
}

function readMaybe(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function run(clientRoot, serverRoot, requireServer) {
  const src = join(clientRoot, "src-tauri", "src");
  if (!existsSync(src)) { console.error("✗ 客户端源码树不在：" + src + "（**不算通过**）"); return 2; }
  const frameKindRs = readMaybe(join(src, "sync_stream.rs"));
  if (frameKindRs === null) { console.error("✗ 读不到 `src-tauri/src/sync_stream.rs`（**不算通过**）"); return 2; }

  const serverSrc = serverRoot ? join(serverRoot, "src") : null;
  const serverThere = Boolean(serverSrc && existsSync(serverSrc));
  if (!serverThere && requireServer) {
    console.error("✗ 已给 `--require-server`，但服务端源码不在：" + (serverSrc ?? "(未指定)") + " ⇒ 按「无可检查对象」exit 2（**不算通过** ✗）");
    return 2;
  }

  const inputs = {
    frameKindRs,
    collabRs: serverThere ? readMaybe(join(serverSrc, "collab.rs")) : null,
    mainRs: serverThere ? readMaybe(join(serverSrc, "main.rs")) : null,
    syncRs: serverThere ? readMaybe(join(serverSrc, "sync.rs")) : null,
    dbRs: serverThere ? readMaybe(join(serverSrc, "db.rs")) : null,
  };
  const skipped = serverThere ? [] : ["① 空间是唯一边界", "①b 白名单交叉核", "② 推送不带正文", "③ 没有\"好友\"关系"];

  const findings = judge(inputs);
  if (findings.length) { for (const x of findings) console.error(x); return 1; }

  if (skipped.length) {
    console.error("  ! 自报跳过（不装绿）：服务端仓不在（" + (serverSrc ?? "(未指定)") + "）⇒ " +
      skipped.join(" ／ ") + " 这四项**没有可检查对象**（CI 上只检出客户端仓 ⇒ 这是常态 ✓；要那次红就加 `--require-server` ✓）");
  }
  console.log("✓ IM 边界成立｜④ 客户端只认 `push`／`ping` 两种帧且不碰内容 ✓" +
    (serverThere ? "｜① 空间是唯一边界（例外仅 3 条用户级通知，且路由不在 `/spaces/` 下 ✓）｜② 推送帧无内容字段 ✓｜③ 无关系类表 ✓" : ""));
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  const good = {
    frameKindRs: 'pub fn frame_kind(payload: &str) -> &\'static str {\n    match serde_json::from_str::<Value>(payload) {\n        Ok(v) => match v.get("type").and_then(Value::as_str) {\n            Some("push") => "push",\n            Some("ping") => "ping",\n            _ => "other",\n        },\n        Err(_) => "other",\n    }\n}\n',
    collabRs: 'pub async fn heartbeat() {\n    require_space(&conn, &user.0, &space_id, "viewer")?;\n}\npub async fn list_notifications() {\n    let x = 1;\n}\npub async fn seen_notification() {\n    let x = 2;\n}\npub async fn seen_all() {\n    let x = 3;\n}\n',
    mainRs: '.route("/spaces/{id}/presence", post(collab::heartbeat))\n.route("/notifications", get(collab::list_notifications))\n.route("/notifications/{id}/seen", post(collab::seen_notification))\n.route("/notifications/seen-all", post(collab::seen_all))\n',
    syncRs: 'pub fn push_frame(space_id: &str, accepted: usize, seq: i64) -> serde_json::Value {\n    serde_json::json!({ "type": "push", "space_id": space_id, "accepted": accepted, "seq": seq })\n}\n',
    dbRs: Array.from({ length: 16 }, (_, i) => "CREATE TABLE IF NOT EXISTS t" + i + " (a TEXT);").join("\n"),
  };
  const cases = [
    ["合规 ⇒ 空", judge(good).length === 0],
    ["handler 漏了 require_space ⇒ 红", judge({ ...good, collabRs: good.collabRs.replace('require_space(&conn, &user.0, &space_id, "viewer")?;\n', "") }).some((s) => s.includes("不经空间门"))],
    ["白名单里的名字查无此函数 ⇒ 红（白名单过期）", judge({ ...good, collabRs: good.collabRs.replace(/pub async fn list_notifications[\s\S]*$/, "") }).some((s) => s.includes("白名单过期"))],
    ["白名单被用来夹带空间级路由 ⇒ 红", judge({ ...good, mainRs: good.mainRs.replace('"/notifications"', '"/spaces/{id}/notifications"') }).some((s) => s.includes("借白名单逃过"))],
    ["推送帧里加了 body ⇒ 红", judge({ ...good, syncRs: good.syncRs.replace('"accepted": accepted,', '"body": "x",') }).some((s) => s.includes("内容类字段"))],
    ["推送帧被改空 ⇒ 红（正向锚）", judge({ ...good, syncRs: good.syncRs.replace('"space_id": space_id, "accepted": accepted, "seq": seq', '"ok": true') }).some((s) => s.includes("没有 `space_id`"))],
    ["schema 里加了 friends 表 ⇒ 红", judge({ ...good, dbRs: good.dbRs + "\nCREATE TABLE IF NOT EXISTS friends (a TEXT);" }).some((s) => s.includes("关系类表"))],
    ["schema 只解析到 2 张表 ⇒ 红（不许假绿）", judge({ ...good, dbRs: "CREATE TABLE IF NOT EXISTS a (x TEXT);\nCREATE TABLE IF NOT EXISTS b (x TEXT);" }).some((s) => s.includes("没检查到东西"))],
    ["客户端认了第三种帧 ⇒ 红", judge({ ...good, frameKindRs: good.frameKindRs.replace('Some("ping") => "ping",', 'Some("ping") => "ping",\n            Some("comment") => "comment",') }).some((s) => s.includes("第三种帧"))],
    ["frame_kind 里出现内容字段 ⇒ 红", judge({ ...good, frameKindRs: good.frameKindRs.replace('Err(_) => "other",', 'let _x = v.get("body");\n        Err(_) => "other",') }).some((s) => s.includes("帧解析不许碰内容"))],
    ["服务端源码不在 ⇒ 只查客户端那半边（不假红 ✗）", judge({ ...good, collabRs: null, mainRs: null, syncRs: null, dbRs: null }).length === 0],
  ];
  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? "  ✓ " : "  ✗ ") + n); if (ok) pass++; }
  console.log("self-test: " + pass + "/" + cases.length + " 通过");
  process.exit(pass === cases.length ? 0 : 1);
}

const get = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
const clientRoot = get("--root", ROOT);
const serverRoot = get("--server", join(clientRoot, "..", "shuyonote-sync-server"));
process.exit(run(clientRoot, serverRoot, argv.includes("--require-server")));
