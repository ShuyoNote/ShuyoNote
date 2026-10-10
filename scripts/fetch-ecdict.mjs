// 取回并转换 ECDICT（英汉词典）→ SQLite，产出**能力包**（owner 2026-10-09：「词库放能力包，按需下载」）。
//
// 这一条是**开发侧**的产出工具：它把上游 CSV 变成"待托管的那份 pack"，并报出 pack 的 **sha256 与字节数**
// —— 那两个读数就是 `src-tauri/src/abilities.rs` 的白名单与 `src/components/AbilitiesPane.tsx`
// 清单里要填的东西（两处**必须一致**，见 `abilities.rs:21`）。
//
// ```bash
// node scripts/fetch-ecdict.mjs                     # 全量：流式取回 CSV → 建 ecdict.db → 报两个 sha256
// node scripts/fetch-ecdict.mjs --pack-out <路径>    # 另把 pack 复制到某处（待托管的那份）
// node scripts/fetch-ecdict.mjs --install           # 另把 pack 放进本机「能力包」目录（联调用）
// node scripts/fetch-ecdict.mjs --sample 20000      # 只要前 N 条（HTTP Range，几 MB）⇒ 小样本库
// node scripts/fetch-ecdict.mjs --check             # 只核对本地那份 pack（不联网）
// node scripts/fetch-ecdict.mjs --print-sha256 <文件>
// ```
//
// ## ⚠️ 数据不入库
//
// `ecdict.csv`（上游 **65,933,428 字节**，实测）与产出的 `ecdict.db` 都在
// `src-tauri/assets/ecdict/`，由 `src-tauri/.gitignore` 挡掉。许可原文（MIT）与占位 README **入库**。
//
// ## ⚠️ 为什么主路是 api.github.com 的 blobs 而不是 raw 直链（**实测**）
//
// 同一份数据、同样一个 1 MiB 的 Range 请求（2026-10-09 本机，`_tmp/scratch/ecdict/probe-range.mjs`）：
//
// ```text
// https://raw.githubusercontent.com/…   1 MiB → 226,741 ms（4 MiB 直接 FAIL；64 KiB 也 FAIL 过一次）
// https://api.github.com/…/git/blobs/…  1 MiB → 1,094 ms（HTTP 206 ✓，稳定）
// ```
//
// ⇒ 差约 200 倍。主路取不到才回退 raw，两条路都各重试 3 次，失败时把**每条路每一次**的错都打出来。
//
// ## ⚠️ 为什么用 `node:sqlite` 而不是 sql.js
//
// 本仓 `package.json` 里同时有 `sql.js`（Web 运行期用），但**这个脚本只需要 Node 里有个 SQLite**：
// CI 与本机都是 **Node 22**（`.github/workflows/*.yml` 全部 `node-version: "22"`），
// 而 `node:sqlite` 是 22.5+ 内置 ⇒ **零依赖**、也不必加载 wasm。⚠️ 它是 experimental，
// Node 会多打一行 `ExperimentalWarning` —— 那行不是本脚本的报错。

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/**
 * 钉死的上游版本。
 *
 * ⚠️ **钉 commit ＋ blob sha，不钉分支** —— `master` 会动，而"许可与体量"的结论是**针对某一版**说的
 * （2026-10-09 实测：`license.spdx_id = "MIT"`；`ecdict.csv` = 65,933,428 字节）。
 */
const PIN = {
  repo: "skywind3000/ECDICT",
  commit: "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b",
  /** 这一版 `ecdict.csv` 的 git blob sha（`GET /repos/…/contents/ecdict.csv?ref=<commit>` 的 `sha`）。 */
  blobSha: "c4ade63ea08cf39d9c3475e96929036d64d94c94",
  /** `ecdict.csv` 的 sha256。**空串 = 没实测过** ⇒ 结尾按"不算通过"退出（见 `report`）。 */
  csvSha256: "1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf",
  csvBytes: 65_933_428,
  /** 我们产出的 **pack**（= `ecdict.db`）的 sha256 与字节数 —— 能力包那条链钉的就是这两个读数。
   *  ⚠️ 2026-10-09 实测（770,611 条词条）：89,735,168 字节。 */
  dbSha256: "5dc10a51f33a0a61d4cb4f368a220a50f8bccb8c2ff3488fdadd5eaaaea2bb31",
  dbBytes: 89_735_168,
};
const RAW_URL = `https://raw.githubusercontent.com/${PIN.repo}/${PIN.commit}/ecdict.csv`;
const BLOB_URL = `https://api.github.com/repos/${PIN.repo}/git/blobs/${PIN.blobSha}`;

/** pack id：与 `abilities.rs` 白名单、`AbilitiesPane.tsx` 清单**逐字一致**（同源两处）。 */
export const PACK_ID = "ecdict-en-zh";

/** 与上游 CSV 表头**逐字**一致（顺序即建表顺序；改这里必须同步 `dictionary.rs` 的 SELECT）。 */
const COLUMNS = [
  "word", "phonetic", "definition", "translation", "pos", "collins",
  "oxford", "tag", "bnc", "frq", "exchange", "detail", "audio",
];
const DATA_DIR = join(ROOT, "src-tauri", "assets", "ecdict");
const DB_PATH = join(DATA_DIR, "ecdict.db");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (m) => console.log(`[fetch-ecdict] ${m}`);
function die(msg, code = 2) {
  console.error(`[fetch-ecdict] ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// CSV 状态机（跨 chunk 切行）
// ---------------------------------------------------------------------------

/**
 * 每切出一整行就回调 `onRow(fields)`（含表头那一行，由调用方自己认）。
 *
 * ⚠️ 为什么不能用 `chunk.split("\n")`：上游的 `translation`/`detail` 里有**引号包裹的换行**，
 * 按行切会把一条词条切成两条。本仓在"跨行处理"上栽过（合成用例全绿、真文件照错），
 * 所以这里用显式状态机，且**只**认上游这一种引号规则（`""` = 一个字面引号）。
 */
function makeCsvSplitter(onRow) {
  let field = "";
  let row = [];
  let inQuotes = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    onRow(row);
    row = [];
  };
  return {
    push(text) {
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i++;
            } else {
              inQuotes = false;
            }
          } else {
            field += c;
          }
          continue;
        }
        if (c === '"' && field === "") {
          inQuotes = true;
          continue;
        }
        if (c === ",") {
          endField();
          continue;
        }
        if (c === "\n") {
          if (field.endsWith("\r")) field = field.slice(0, -1);
          endRow();
          continue;
        }
        field += c;
      }
    },
    end() {
      if (field.length || row.length) endRow();
    },
  };
}

/** 逐段解 UTF-8：把"跨段的半个字符"留到下一段（否则中文会变成 U+FFFD，而它正是词条内容）。 */
function makeUtf8Stream() {
  let tail = Buffer.alloc(0);
  return (buf) => {
    const all = Buffer.concat([tail, buf]);
    // 从尾部最多回退 3 字节找**完整字符**边界：ASCII 结尾 ⇒ 就地；先遇续字节再遇首字节 ⇒ 边界在其前。
    let cut = all.length;
    for (let back = 0; back < 3 && cut > 0; back++) {
      const b = all[cut - 1];
      if ((b & 0x80) === 0) break;
      cut -= 1;
      if ((b & 0xc0) === 0xc0) break;
    }
    tail = all.subarray(cut);
    return all.subarray(0, cut).toString("utf8");
  };
}

// ---------------------------------------------------------------------------
// 建库（表头对不上 ⇒ 当场停）
// ---------------------------------------------------------------------------

function checkHeader(fields) {
  const got = fields.map((f) => f.trim());
  if (got.length === COLUMNS.length && got.every((f, i) => f === COLUMNS[i])) return true;
  // 列错位会让 definition 跑进 translation，而那种错**不报错**，只让用户看到错位的释义
  // （比空白更坏）⇒ 宁可停。
  throw new Error(`CSV 表头与预期不一致 ⇒ 拒绝建库：\n  期望 ${COLUMNS.join(",")}\n  实际 ${got.join(",")}`);
}

function makeDbWriter(dbPath) {
  if (existsSync(dbPath)) unlinkSync(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE stardict (
      word        TEXT PRIMARY KEY,
      phonetic    TEXT,
      definition  TEXT,
      translation TEXT,
      pos         TEXT,
      collins     INTEGER,
      oxford      INTEGER,
      tag         TEXT,
      bnc         INTEGER,
      frq         INTEGER,
      exchange    TEXT,
      detail      TEXT,
      audio       TEXT
    );
  `);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO stardict (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`,
  );
  db.exec("BEGIN");
  let headerOk = false;
  let rows = 0;
  let skipped = 0;
  return {
    get headerOk() {
      return headerOk;
    },
    get rows() {
      return rows;
    },
    onRow(fields) {
      if (!headerOk) {
        headerOk = checkHeader(fields);
        return;
      }
      if (fields.length !== COLUMNS.length) {
        skipped += 1;
        return;
      }
      ins.run(...fields.map((f) => (f === "" ? null : f)));
      rows += 1;
    },
    finish() {
      db.exec("COMMIT");
      const count = db.prepare("SELECT count(*) AS n FROM stardict").get().n;
      db.close();
      return { rows, skipped, count };
    },
  };
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub 令牌（**只从环境变量读，⛔ 从不打印**）。
 *
 * ⚠️ 为什么需要它：blob API 匿名额度是 **60 次/小时**，而全量取回要 ~60 个 Range 请求
 * ⇒ 本机实测**正好撞上限流**（第 57 个请求起 `HTTP 403`，`/rate_limit` 读数 `core.remaining = 0`）。
 * 给了令牌就是 5000 次/小时 ⇒ 一次跑完。
 * ⛔ 令牌**只进请求头**，不进任何日志/读数（连长度都不打印）。
 */
const TOKEN = process.env.GH_TOKEN || "";

/**
 * 一次 Range：**主路 blob API，失败回退 raw**；每路重试 `tries` 次，错全留着。
 *
 * ⚠️ **Range 请求不带令牌** —— 实测：带了 `Authorization` 时 Range **被忽略**（返回 200 ＋ 整份
 * 90,841,911 字节，57,967 ms），反而比匿名 206 更贵。所以：Range（小样本）走匿名，
 * 整份走带令牌的一次请求（见 `fetchWholeCsv`）。
 */
async function fetchRange(start, end, { tries = 3 } = {}) {
  const errors = [];
  for (const [name, url] of [["blob", BLOB_URL], ["raw", RAW_URL]]) {
    const headers = { Range: `bytes=${start}-${end}` };
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const res = await fetch(url, { headers });
        if (res.status === 403 && name === "blob") {
          throw new Error("HTTP 403（匿名额度 60 次/小时用尽 ⇒ 整份请用 GH_TOKEN 走一次请求）");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) {
        errors.push(`${name} ${start}-${end} 第${attempt}次：${e.message}`);
        await sleep(400 * attempt);
      }
    }
  }
  throw new Error(`Range ${start}-${end} 两条路都不通：\n  ${errors.join("\n  ")}`);
}

/**
 * 全量：**一次请求**拿整份（blob API 的 base64 JSON）—— 实测这条最快。
 *
 * ```text
 * 带令牌、不带 Range ⇒ HTTP 200、**90,841,911 字节的 base64 JSON**（= 65,933,428 的 CSV）→ 57,967 ms
 * 带令牌、带 Range   ⇒ 那个 Range **被忽略**（仍是 200 ＋ 整份）⇒ Range 只用于匿名小样本
 * 匿名、带 Range     ⇒ 206 ✓ 1 MiB ≈ 1,094 ms，但**额度只有 60 次/小时**（跑全量会在第 57 个请求撞 403）
 * ```
 *
 * ⇒ 全量走"一次请求"，小样本走"匿名 Range"（见 `--sample`）。
 */
async function fetchWholeCsv() {
  const headers = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const errors = [];
  // ⚠️ 实测：这一次请求是 **90MB 级**，本机网络会偶发 `TypeError: terminated`
  // （探针那次 57,967 ms 成功、随后的正式跑就断在半路）⇒ 必须重试，别把一次抖动读成"拿不到"。
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(BLOB_URL, { headers });
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}` +
            (res.status === 403 ? "（匿名额度 60 次/小时用尽 ⇒ 设 GH_TOKEN 环境变量；令牌只进请求头、不打印）" : ""),
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const j = JSON.parse(buf.toString("utf8"));
        if (j.encoding !== "base64" || typeof j.content !== "string") {
          throw new Error(`blob 返回的形状不是 base64（encoding=${j.encoding}）⇒ 不猜`);
        }
        return {
          csv: Buffer.from(j.content.replace(/\s/g, ""), "base64"),
          how: `blob API 一次请求（base64 JSON；第 ${attempt} 次，${Date.now() - t0} ms）`,
        };
      }
      return { csv: buf, how: `blob API 一次请求（裸字节；第 ${attempt} 次，${Date.now() - t0} ms）` };
    } catch (e) {
      errors.push(`第${attempt}次：${e.message}（${Date.now() - t0} ms）`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error(
    `整份取回三次都没成：\n  ${errors.join("\n  ")}\n  ⇒ 另一条路：把 CSV 先下到本地再 ` +
      `--from-csv <路径>（例如 curl 拉 codeload 的 tar.gz 再解出 ecdict.csv）`,
  );
}

/**
 * 全量主流程：一次请求拿到整份 → 边哈希边灌库。
 * 返回 `{ csvSha256, csvBytes, db, headerOk, elapsed, how }`。
 */
async function buildFull() {
  const t0 = Date.now();
  const { csv, how } = await fetchWholeCsv();
  log(`  取回方式：${how}；${csv.length} 字节，${Date.now() - t0} ms`);
  const hash = createHash("sha256").update(csv).digest("hex");
  const writer = makeDbWriter(DB_PATH);
  const splitter = makeCsvSplitter((f) => writer.onRow(f));
  // CSV 是完整文本 ⇒ 直接整份喂给状态机（不需要跨 chunk 的解码流）。
  splitter.push(csv.toString("utf8"));
  splitter.end();
  const stats = writer.finish();
  return {
    csvSha256: hash,
    csvBytes: csv.length,
    db: stats,
    headerOk: writer.headerOk,
    elapsed: Date.now() - t0,
    how,
  };
}

/** 小样本：前 N 条（Range 取，几 MB）。 */
async function buildSample(limit) {
  const CHUNK = 1 << 20;
  const decode = makeUtf8Stream();
  const writer = makeDbWriter(DB_PATH);
  const splitter = makeCsvSplitter((f) => writer.onRow(f));
  let bytes = 0;
  while (writer.rows <= limit) {
    const buf = await fetchRange(bytes, bytes + CHUNK - 1);
    if (buf.length === 0) break;
    splitter.push(decode(buf));
    bytes += buf.length;
    if (buf.length < CHUNK) break;
  }
  splitter.end();
  const stats = writer.finish();
  return { bytes, db: stats, headerOk: writer.headerOk };
}

// ---------------------------------------------------------------------------
// 读数 / 安装
// ---------------------------------------------------------------------------

const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Tauri 的 `app_data_dir`（bundle identifier 见 `src-tauri/tauri.conf.json`）。 */
function appDataDir() {
  const id = "cn.shuyo.shuyonote";
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), id);
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", id);
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), id);
}

/** pack 在应用数据目录里的落点（⭐ 与 `abilities.rs::save_ability_pack` 的落盘形状**逐字一致**）。 */
const installedPackPath = () => join(appDataDir(), "packs", PACK_ID, `${PACK_ID}.bin`);

/** 打印两个读数并给出"填哪里"。返回值决定退出码（**没核过 ⇒ 不算通过**）。 */
function report({ sample = false } = {}) {
  const dbBytes = statSync(DB_PATH).size;
  const dbSha = sha256Of(DB_PATH);
  log(`产出：${DB_PATH}`);
  log(`  pack 字节数 = ${dbBytes}`);
  log(`  pack sha256 = ${dbSha}`);
  if (!sample) {
    log(`  CSV  sha256 = ${PIN.csvSha256 || "（还没实测 ⇒ 见下面那行提示）"}`);
  }
  log("—— 要填的两处（**必须一致**）：");
  log(`  · src-tauri/src/abilities.rs 的 expected_sha256("${PACK_ID}") => "${dbSha}"`);
  log(`  · src/components/AbilitiesPane.tsx 清单里 id=${PACK_ID} 的 bytes=${dbBytes} / sha256="${dbSha}"`);
  if (sample) {
    log("⚠️ 这是**小样本**库：它的 sha256/字节数**不是**要上架那份 ⇒ ⛔ 别填进白名单。");
    return true;
  }
  if (!PIN.csvSha256) {
    log("⚠️ PIN.csvSha256 还没填（上游那份 CSV 的哈希这次才第一次量到）⇒ 本次**不算通过**。");
    return false;
  }
  if (PIN.dbSha256 && PIN.dbSha256 !== dbSha) {
    log(`⚠️ 与 PIN.dbSha256 不同：钉 ${PIN.dbSha256} / 本次 ${dbSha}`);
    log("   ⇒ 两份 pack 内容不同。SQLite 的字节**不保证**跨版本可复现 ⇒ 上架那份应当**只由一台机器产出一次**");
    log("     （能力包那条链钉的是**产物**的 sha256，不是「每次自己重建」）。");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const printSha = valueOf("--print-sha256");
  if (printSha) {
    const p = resolve(printSha);
    if (!existsSync(p)) die(`找不到文件：${p}`);
    console.log(sha256Of(p));
    return;
  }

  if (has("--check")) {
    if (!existsSync(DB_PATH)) die(`本地没有 ${DB_PATH}（先跑一次不带参数的）`, 2);
    const bytes = statSync(DB_PATH).size;
    const sha = sha256Of(DB_PATH);
    log(`本地 pack：${bytes} 字节 / sha256 ${sha}`);
    if (!PIN.dbSha256) {
      log("⚠️ PIN.dbSha256 还是空的（这份产物没被钉过）⇒ 不算通过");
      process.exit(2);
    }
    if (PIN.dbSha256 !== sha) die(`pack 的 sha256 与钉的不一致 ⇒ 这份不是上架那一份`, 1);
    log("与钉的一致 ✓");
    return;
  }

  const started = Date.now();
  const sampleN = Number(valueOf("--sample") || 0);
  let ok;

  // ⭐ `--from-csv <路径>`：**不经网络**从一份已经下到本地的 CSV 建库。
  // 为什么要有它：整份是 90MB 级的一次请求，本机网络会偶发中断（实测 `TypeError: terminated`）
  // ⇒ 得留一条"先自己把它下下来（curl 能续传/可重试），再本地建库"的路 —— 也更可复现。
  const fromCsv = valueOf("--from-csv");
  if (fromCsv) {
    const p = resolve(fromCsv);
    if (!existsSync(p)) die(`找不到 CSV：${p}`);
    const buf = readFileSync(p);
    const csvSha = sha256Of(p);
    log(`本地 CSV：${p}（${buf.length} 字节 / sha256 ${csvSha}）`);
    if (PIN.csvBytes && PIN.csvBytes !== buf.length) {
      log(`⚠️ 体量与记录不同：记录 ${PIN.csvBytes} / 实际 ${buf.length}（不是钉的那一份？）`);
    }
    if (PIN.csvSha256 && PIN.csvSha256 !== csvSha) {
      die(`CSV 的 sha256 与钉的不符 ⇒ 拒收：\n  钉 ${PIN.csvSha256}\n  实测 ${csvSha}`, 1);
    }
    const writer = makeDbWriter(DB_PATH);
    const splitter = makeCsvSplitter((f) => writer.onRow(f));
    splitter.push(buf.toString("utf8"));
    splitter.end();
    const stats = writer.finish();
    if (!writer.headerOk) die("表头没对上 ⇒ 拒绝建库（见上面那条 throw）", 1);
    log(`词典库：${stats.count} 条词条（跳过 ${stats.skipped} 行），${Date.now() - started} ms`);
    ok = report();
  } else if (sampleN > 0) {
    log(`小样本模式：Range 取前 ${sampleN} 条（不下载整份 62.9 MiB）`);
    const r = await buildSample(sampleN);
    if (!r.headerOk) die("样本表头没对上 ⇒ 拒绝建库（见上面那条 throw）", 1);
    log(`样本库：${r.db.count} 条词条（跳过 ${r.db.skipped} 行），读了 ${Math.round(r.bytes / 1024)} KiB，${Date.now() - started} ms`);
    ok = report({ sample: true });
  } else {
    log(`全量模式：${BLOB_URL}`);
    log(`  钉的版本：${PIN.repo}@${PIN.commit.slice(0, 12)}（记录体量 ${PIN.csvBytes} 字节）`);
    const r = await buildFull();
    if (!r.headerOk) die("表头没对上 ⇒ 拒绝建库（见上面那条 throw）", 1);
    log(`CSV：${r.csvBytes} 字节 / sha256 ${r.csvSha256}（${Date.now() - started} ms）`);
    if (PIN.csvBytes && PIN.csvBytes !== r.csvBytes) {
      log(`⚠️ 体量与记录不同：记录 ${PIN.csvBytes} / 实际 ${r.csvBytes}`);
    }
    if (PIN.csvSha256 && PIN.csvSha256 !== r.csvSha256) {
      die(`CSV 的 sha256 与钉的不符 ⇒ 拒收（防上游悄悄换内容）：\n  钉 ${PIN.csvSha256}\n  实测 ${r.csvSha256}`, 1);
    }
    log(`词典库：${r.db.count} 条词条（跳过 ${r.db.skipped} 行）`);
    ok = report();
  }

  const packOut = valueOf("--pack-out");
  if (packOut) {
    const dest = resolve(packOut);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(DB_PATH, dest);
    log(`pack 已复制到：${dest}（这就是**待托管**的那一份）`);
  }
  if (has("--install")) {
    const dest = installedPackPath();
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(DB_PATH, dest);
    log(`已装进本机「能力包」目录：${dest}`);
    await installAuditLine(dest);
  }
  log(`下一步：node scripts/dictionary-bench.mjs --db "${DB_PATH}"`);
  if (!ok) process.exit(2);
}

/** 与 `abilities.rs` 的审计同一行形状（联调时"这份从哪来"可核）。 */
async function installAuditLine(dest) {
  const { appendFileSync } = await import("node:fs");
  const line = `${new Date().toISOString()}\tpack=${PACK_ID}\tbytes=${statSync(dest).size}\tsha256=${sha256Of(dest)}\tsource=fetch-ecdict.mjs\n`;
  appendFileSync(join(dirname(dest), "audit.log"), line);
}

main().catch((e) => die(`${e?.stack || e}`, 2));
