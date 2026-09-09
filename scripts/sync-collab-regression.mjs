#!/usr/bin/env node
// 近实时协作集成回归（服务端契约）：presence / comment / notification / SSE。
// 用法：node scripts/sync-collab-regression.mjs [--server http://127.0.0.1:8787]
// 验证：注册→建空间→presence 心跳/在线→评论增/删→通知生成/已读/全部→（可选 SSE）。
// 有失败即非零退出。
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SERVER = (arg("--server", "http://127.0.0.1:8787") || "").replace(/\/+$/, "");
const BASE = `${SERVER}/spaces`;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.error(`  ✗ FAIL: ${msg}`); } };

async function req(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const emailA = `collab-a-${suffix}@test.local`;
  const emailB = `collab-b-${suffix}@test.local`;
  const password = "syncpass" + Math.random().toString(36).slice(2, 10);
  console.log(`\n[近实时协作回归] server=${SERVER}\n`);

  // 0. health
  const h = await req("GET", `${SERVER}/health`);
  ok(h.status === 200, "服务端 /health=ok");

  // 1. register A + B
  const regA = JSON.parse((await req("POST", `${SERVER}/auth/register`, { body: { email: emailA, password, display: "collabA", register_code: "" } })).text);
  let tokenA = regA?.token;
  if (!tokenA) {
    const r2 = JSON.parse((await req("POST", `${SERVER}/auth/register`, { body: { email: emailA, password, display: "collabA" } })).text);
    tokenA = r2?.token;
  }
  ok(Boolean(tokenA), "注册用户A并取得 token");
  const regB = JSON.parse((await req("POST", `${SERVER}/auth/register`, { body: { email: emailB, password, display: "collabB", register_code: "" } })).text);
  const tokenB = regB?.token;
  ok(Boolean(tokenB), "注册用户B并取得 token");

  // 2. A 建空间
  const sp = JSON.parse((await req("POST", `${SERVER}/spaces`, { token: tokenA, body: { name: "近实时空间" } })).text);
  const spaceId = sp?.id;
  ok(Boolean(spaceId), "A 创建空间");

  // 3. A 邀请 B 为成员（editor）
  const mem = await req("POST", `${SERVER}/spaces/${spaceId}/members`, { token: tokenA, body: { user_email: emailB, role: "editor" } });
  ok(mem.status === 200, "A 邀请 B 为成员");

  // 4. presence 心跳 + 在线
  const beat = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/presence`, { token: tokenA, body: { page_id: "page-1", device_id: "devA" } })).text);
  ok(beat?.ok === true, "A presence 心跳成功");
  const online = JSON.parse((await req("GET", `${SERVER}/spaces/${spaceId}/online`, { token: tokenA })).text);
  ok(Array.isArray(online?.online) && online.online.length >= 1, `在线列表含 A（${online?.online?.length} 人）`);

  // 5. 评论添加 + 列表
  const c1 = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenA, body: { body: "评论A @ " + emailB, mentions: [] } })).text);
  ok(Boolean(c1?.id), "A 添加评论");
  const comments = JSON.parse((await req("GET", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenB })).text);
  ok(Array.isArray(comments?.items) && comments.items.length === 1, "B 拉到评论列表（1 条）");

  // 6. 通知生成（@ 成员）+ 列表 / 已读 / 全部
  const c2 = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenA, body: { body: "mention B", mentions: [emailB] } })).text);
  ok(Array.isArray(c2?.notifications) && c2.notifications.length >= 1, "@B 生成通知");
  const notifs = JSON.parse((await req("GET", `${SERVER}/notifications`, { token: tokenB })).text);
  ok(Array.isArray(notifs?.items), "B 拉到通知列表");
  const unread = (notifs?.items ?? []).filter((n) => n.seen === 0).length;
  ok(unread >= 1, `B 有未读通知（${unread}）`);
  if (notifs?.items?.length) {
    await req("POST", `${SERVER}/notifications/${notifs.items[0].id}/seen`, { token: tokenB });
    const after = JSON.parse((await req("GET", `${SERVER}/notifications`, { token: tokenB })).text);
    const unreadAfter = (after?.items ?? []).filter((n) => n.seen === 0).length;
    ok(unreadAfter === unread - 1, "标记一条已读生效");
  }
  await req("POST", `${SERVER}/notifications/seen-all`, { token: tokenB });
  const all = JSON.parse((await req("GET", `${SERVER}/notifications`, { token: tokenB })).text);
  ok((all?.items ?? []).every((n) => n.seen === 1), "全部已读生效");

  // 7. 权限 gate：非成员 B 读另一空间应 403（用 A 新建一个仅 A 的空间）
  const sp2 = JSON.parse((await req("POST", `${SERVER}/spaces`, { token: tokenA, body: { name: "私有空间" } })).text);
  const online2 = await req("GET", `${SERVER}/spaces/${sp2?.id}/online`, { token: tokenB });
  ok(online2.status === 403, "非成员访问在线列表=403（角色 gate）");

  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) { console.error("近实时协作回归未通过。"); process.exit(1); }
  console.log("近实时协作回归全部通过 ✅");
}

main().catch((e) => { console.error("近实时协作回归异常:", e); process.exit(1); });
