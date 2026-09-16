#!/usr/bin/env node
// 跨设备同步一致性回归脚本（服务端契约）。
// 用法：node scripts/sync-regression.mjs [--server http://127.0.0.1:8787] [--code SHUYOTEST]
// 验证：注册→建空间→A push→B pull 全量→双端互改→互补 pull 收敛→幂等(同 seq 不重复)→
//       附件 SHA-256(正确 200 / 错误 400 / 下载字节一致)→增量(since 只给新增)。
import { createHash, randomUUID } from "node:crypto";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SERVER = (arg("--server", "http://127.0.0.1:8787") || "").replace(/\/+$/, "");
const CODE = arg("--code", "SHUYOTEST");
/** 个人/无账户部署（K1/K2）用：直接拿服务端签发的 `sk_` 密钥，跳过注册/登录。 */
const DEVICE_KEY = arg("--device-key", "");
const BASE = `${SERVER}/spaces`;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ FAIL: ${msg}`); } };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function req(method, url, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const email = `sync-reg-${suffix}@test.local`;
  const password = "syncpass" + Math.random().toString(36).slice(2, 10);
  console.log(`\n[同步一致性回归] server=${SERVER}  ${DEVICE_KEY ? "auth=设备密钥（个人/无账户）" : `user=${email}`}`);

  // 0. health
  const h = await req("GET", `${SERVER}/health`);
  ok(h.status === 200 && /\bok\b/.test(h.text), "服务端 /health=ok");

  // 1+2. 认证与空间：两条路二选一
  //
  //   · 默认（账号制 / 团队版）：注册 → 拿 token → 建空间；
  //   · `--device-key sk_…`（个人/无账户部署，K1/K2）：**没有注册这一步** —— 客户端拿服务端
  //     签发的一把 key 就连上了；空间由服务端侧用 CLI 建好（`--issue-device-key`），这里问出来即可。
  //     这条路正是官网「个人自建同步 ¥199 一次性买断」那一档的实际用法，所以必须有自动化判据
  //     —— 光有服务端单测证明不了"客户端这条链路真的能连上"。
  let token;
  let spaceId;
  if (DEVICE_KEY) {
    token = DEVICE_KEY;
    const listRes = await req("GET", `${SERVER}/spaces`, { token });
    const list = (() => { try { return JSON.parse(listRes.text)?.spaces ?? []; } catch { return []; } })();
    const sp = list[0];
    spaceId = sp?.id;
    ok(Boolean(token), "使用服务端签发的设备密钥（无注册、无登录）");
    ok(Boolean(spaceId), "密钥能列出自己的空间");
    ok(sp?.role === "owner", `密钥在该空间的身份是 owner（实测 ${sp?.role ?? "无"}）——「持钥即拥有」`);
  } else {
    const reg = await req("POST", `${SERVER}/auth/register`, { body: { email, password, display: "sync-reg", register_code: CODE } });
    try { token = JSON.parse(reg.text)?.token; } catch {}
    if (!token) {
      // 无邀请码的服务器：用空码重试。
      const reg2 = await req("POST", `${SERVER}/auth/register`, { body: { email, password, display: "sync-reg", register_code: "" } });
      token = JSON.parse(reg2.text)?.token;
    }
    ok(Boolean(token), "注册成功并取得 token");

    const sp = JSON.parse((await req("POST", `${SERVER}/spaces`, { token, body: { name: "回归空间" } })).text);
    spaceId = sp?.id;
    ok(Boolean(spaceId), "创建组织空间");
  }

  // 3. device A push a set of changes (pages + attachment metadata)
  const devA = "dev-" + randomUUID().slice(0, 8);
  const devB = "dev-" + randomUUID().slice(0, 8);
  const now = Date.now();
  const A_changes = [
    { device_seq: 1, entity: "page", entity_id: "page-a1", op: "upsert", payload: JSON.stringify({ id: "page-a1", title: "A页1" }), updated_at: now },
    { device_seq: 2, entity: "page", entity_id: "page-a2", op: "upsert", payload: JSON.stringify({ id: "page-a2", title: "A页2" }), updated_at: now },
    { device_seq: 3, entity: "attachment", entity_id: "att-a1", op: "upsert", payload: JSON.stringify({ id: "att-a1", hash: "f".repeat(64), mime: "text/plain", size: 3 }), updated_at: now },
  ];
  const pushA1 = JSON.parse((await req("POST", `${SERVER}/push`, { token, body: { device_id: devA, space_id: spaceId, changes: A_changes } })).text);
  ok(pushA1.ok === true && (pushA1.accepted ?? 0) === A_changes.length, "设备A push 3 条变更被接受");

  // 4. device B pull since=0 → 拿到 A 全部
  const pullB1 = JSON.parse((await req("GET", `${SERVER}/pull?space_id=${spaceId}&since=0&exclude_device=${devB}`, { token })).text);
  const b1 = pullB1?.changes ?? [];
  ok(b1.length === A_changes.length, `设备B 首次 pull 拿到 ${b1.length}/${A_changes.length} 条`);
  const maxSeqB1 = b1.length ? Math.max(...b1.map((c) => c.seq)) : 0;

  // 5. A/B 双方互改：B push 2 条 + A 再 push 2 条，各自 pull 收敛
  const B_changes = [
    { device_seq: 1, entity: "page", entity_id: "page-b1", op: "upsert", payload: JSON.stringify({ id: "page-b1", title: "B页1" }), updated_at: now },
    { device_seq: 2, entity: "page", entity_id: "page-a1", op: "update", payload: JSON.stringify({ id: "page-a1", title: "A页1(被B改)" }), updated_at: now },
  ];
  const pushB = JSON.parse((await req("POST", `${SERVER}/push`, { token, body: { device_id: devB, space_id: spaceId, changes: B_changes } })).text);
  ok(pushB.ok === true && (pushB.accepted ?? 0) === B_changes.length, "设备B push 2 条");

  const A_more = [
    { device_seq: 4, entity: "page", entity_id: "page-a3", op: "upsert", payload: JSON.stringify({ id: "page-a3", title: "A页3" }), updated_at: now },
  ];
  const pushA2 = JSON.parse((await req("POST", `${SERVER}/push`, { token, body: { device_id: devA, space_id: spaceId, changes: A_more } })).text);
  ok(pushA2.ok === true && (pushA2.accepted ?? 0) === A_more.length, "设备A 再 push 1 条");

  const pullA = JSON.parse((await req("GET", `${SERVER}/pull?space_id=${spaceId}&since=0&exclude_device=${devA}`, { token })).text);
  const aChanges = (pullA?.changes ?? []).filter((c) => c.seq > maxSeqB1);
  ok(aChanges.some((c) => c.entity_id === "page-b1"), "设备A pull 到 B 的 page-b1");
  ok(aChanges.some((c) => c.entity_id === "page-a1" && /被B改/.test(c.payload || "")), "设备A pull 到 B 对 page-a1 的更新");

  const pullB2 = JSON.parse((await req("GET", `${SERVER}/pull?space_id=${spaceId}&since=${maxSeqB1}&exclude_device=${devB}`, { token })).text);
  const b2 = pullB2?.changes ?? [];
  ok(b2.some((c) => c.entity_id === "page-a3"), "设备B 增量 pull(since) 拿到 A 的 page-a3");

  // 6. 幂等：A 重复 push 同 device_seq → INSERT OR IGNORE，accepted=0
  const pushIdem = JSON.parse((await req("POST", `${SERVER}/push`, { token, body: { device_id: devA, space_id: spaceId, changes: A_changes } })).text);
  ok((pushIdem.accepted ?? 0) === 0, "重复 push 同 device_seq 幂等（accepted=0）");

  // 7. 附件：正确 SHA-256 → 200；错误 → 400；下载 bytes 一致
  const attBytes = Buffer.from("hello-sync-attachment-回归");
  const attHash = sha256(attBytes);
  const upOK = await req("POST", `${BASE}/${spaceId}/attachments/${attHash}?mime=application/octet-stream`, { token, body: attBytes, raw: true });
  ok(upOK.status === 200, `附件上传(正确哈希)=${upOK.status}`);
  const upBad = await req("POST", `${BASE}/${spaceId}/attachments/${"0".repeat(64)}?mime=application/octet-stream`, { token, body: attBytes, raw: true });
  ok(upBad.status === 400, `附件上传(错哈希)=${upBad.status}(应为400)`);
  const dl = await fetch(`${BASE}/${spaceId}/attachments/${attHash}`, { headers: { Authorization: `Bearer ${token}` } });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  ok(dlBytes.equals(attBytes), "附件下载字节与上传一致");

  // 8. 汇总
  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.error("存在失败项，同步一致性回归未通过。");
    process.exit(1);
  }
  console.log("同步一致性回归全部通过 ✅");
}

main().catch((e) => { console.error("脚本异常:", e); process.exit(1); });
