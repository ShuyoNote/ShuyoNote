#!/usr/bin/env node
// **跨机器多端同步会合测试**：两台机器各跑一次这条命令，各自出 PASS/FAIL。
//
// 与仓库里那两个 CI 脚本（`sync-regression.mjs` / `sync-collab-regression.mjs`）的分工：
// 那两个是"**同一台机器上**用两个 device_id 模拟两端"（自动化、每次 CI 跑）；
// 这个是"**两台真机器**对着同一台服务器、同一个空间"，验证真链路（网络、真客户端进程、
// 真的人在两台机器上）。两者的判据都落到"服务端存了什么"，所以结论对得上。
//
// 协议（两端各执行一次；不需要约定谁先谁后）：
//   ① 我写一页，标题 = `MDTEST:<我的角色>:<时间戳>`，entity_id 固定为 `mdtest-<我的角色>`
//      （固定 ⇒ 重跑是覆盖，不会越攒越多）；
//   ② 轮询对方的页（标题 `MDTEST:<对方角色>:`），最多等 `--wait` 秒；
//   ③ 看到之后**改对方那一页**（追加 `|seen-by-<我>`），再轮询直到对方也改了我的页
//      （我的页里出现 `|seen-by-<对方>`）—— 这一步证明的不只是"新页能同步"，
//      而是**就地更新也能双向到达**（LWW 页级合并）；
//      加 `--rounds 1` 可只跑到 ② 为止。
//
// 用法：
//   node scripts/sync-multidevice.mjs --server http://<mac 的地址>:8787 \
//     --token <会话 token 或 sk_ 设备密钥> --role windows --peer mac
//   （`--space <id>` 可显式指定；不给就取 `GET /spaces` 的第一个）
//   `--json` 额外打印一行机器可读结果，方便贴回来对照。
import { randomUUID } from "node:crypto";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SERVER = (arg("--server", "http://127.0.0.1:8787") || "").replace(/\/+$/, "");
const TOKEN = arg("--token", "");
const ROLE = arg("--role", "");
const PEER = arg("--peer", "");
const SPACE = arg("--space", "");
const WAIT_S = Number(arg("--wait", "180"));
const ROUNDS = Number(arg("--rounds", "2"));
const JSON_OUT = process.argv.includes("--json");

if (!TOKEN || !ROLE) {
  console.error("用法: node scripts/sync-multidevice.mjs --server <url> --token <token|sk_密钥> --role <本端名> [--peer <对端名>] [--space <id>] [--wait 180] [--rounds 2] [--json]");
  process.exit(2);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, text: await res.text() };
}

const DEVICE = `mdtest-${ROLE}-${randomUUID().slice(0, 8)}`;
/** 我这一页的标题；时间戳让"我这次跑"可被对方识别为新的。 */
const MY_TITLE_BASE = `MDTEST:${ROLE}`;
const myStamp = Date.now();

async function pushPage(spaceId, pageId, title, seq) {
  const changes = [
    { device_seq: seq, entity: "page", entity_id: pageId, op: "upsert", payload: JSON.stringify({ id: pageId, title }), updated_at: Date.now() },
  ];
  const r = await req("POST", `${SERVER}/push`, { device_id: DEVICE, space_id: spaceId, changes });
  return r;
}

/** 拉全量，返回 `entity_id → title` 的映射（只看 page）。 */
async function pullTitles(spaceId) {
  const r = await req("GET", `${SERVER}/pull?space_id=${encodeURIComponent(spaceId)}&since=0&limit=1000`);
  if (r.status !== 200) return { error: `HTTP ${r.status}`, map: new Map() };
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    return { error: "返回不是 JSON", map: new Map() };
  }
  const map = new Map();
  for (const c of j.changes ?? []) {
    if (c.entity !== "page") continue;
    try {
      const p = JSON.parse(c.payload ?? "{}");
      if (typeof p.title === "string") map.set(c.entity_id, p.title);
    } catch {
      /* 单条 payload 坏掉不该让整次同步判定失败 */
    }
  }
  return { map, count: (j.changes ?? []).length };
}

async function main() {
  console.log(`\n[多端会合] server=${SERVER} role=${ROLE}${PEER ? ` peer=${PEER}` : ""}`);

  const h = await req("GET", `${SERVER}/health`);
  ok(h.status === 200, `服务端可达（/health HTTP ${h.status}）`);
  if (h.status !== 200) {
    console.error("  服务端不可达 —— 先确认地址/端口/防火墙（Mac 侧：`--port 8787` 且允许局域网访问）。");
    process.exit(1);
  }

  // 空间：显式给，或取列表第一个（设备密钥只有自己那一个空间）
  let spaceId = SPACE;
  if (!spaceId) {
    const r = await req("GET", `${SERVER}/spaces`);
    try {
      spaceId = (JSON.parse(r.text)?.spaces ?? [])[0]?.id;
    } catch {
      /* 下面统一报 */
    }
  }
  ok(Boolean(spaceId), `拿到空间 id（${spaceId ?? "无"}）`);
  if (!spaceId) process.exit(1);

  // ① 写我这一页
  const myPageId = `mdtest-${ROLE}`;
  const myTitle = `${MY_TITLE_BASE}:${myStamp}`;
  const w = await pushPage(spaceId, myPageId, myTitle, 1);
  ok(w.status === 200 && /"ok"\s*:\s*true/.test(w.text), `① 写入我这一页（entity_id=${myPageId}）`);

  // ② 等对方的页
  const peerPageId = `mdtest-${PEER}`;
  let peerTitle = null;
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT_S * 1000) {
    const { map, error } = await pullTitles(spaceId);
    if (error) {
      console.error(`  · pull 出错：${error}（继续等）`);
    } else {
      const t = map.get(peerPageId);
      if (t && t.startsWith(`MDTEST:${PEER}:`)) {
        peerTitle = t;
        break;
      }
      const others = [...map.keys()].filter((k) => k.startsWith("mdtest-")).join(", ");
      process.stdout.write(`\r  等待 ${PEER} 写入… 已 ${Math.round((Date.now() - t0) / 1000)}s（当前 mdtest 页：${others || "无"}）   `);
    }
    await sleep(3000);
  }
  process.stdout.write("\n");
  if (PEER) {
    ok(Boolean(peerTitle), `② 收到 ${PEER} 的页面（${peerTitle ?? `等了 ${WAIT_S}s 没等到`}）`);
  } else {
    console.log("  · 没给 --peer：跳过「等对方」这一步（只写不等）");
  }

  // ③ 互改：我改对方那页 → 等对方改我这页
  if (ROUNDS >= 2 && PEER && peerTitle) {
    const edited = `${peerTitle}|seen-by-${ROLE}`;
    const w2 = await pushPage(spaceId, peerPageId, edited, 2);
    ok(w2.status === 200, `③ 我改动了 ${PEER} 的那一页`);

    const t1 = Date.now();
    let acked = false;
    while (Date.now() - t1 < WAIT_S * 1000) {
      const { map } = await pullTitles(spaceId);
      const mine = map.get(myPageId);
      if (mine && mine.includes(`|seen-by-${PEER}`)) {
        acked = true;
        break;
      }
      process.stdout.write(`\r  等 ${PEER} 回改我这一页… 已 ${Math.round((Date.now() - t1) / 1000)}s   `);
      await sleep(3000);
    }
    process.stdout.write("\n");
    ok(acked, `③ ${PEER} 也改了我的页（双向就地更新可达）`);
  }

  const summary = {
    role: ROLE,
    peer: PEER || null,
    peerSeen: Boolean(peerTitle),
    bidirectional: ROUNDS >= 2 ? fail === 0 : null,
    pass,
    fail,
  };
  console.log(`\n[结果] role=${ROLE} ${pass} 通过 / ${fail} 失败`);
  if (JSON_OUT) console.log(`MDTEST_RESULT ${JSON.stringify(summary)}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`✗ 意外错误：${e?.message ?? e}`);
  process.exit(1);
});
