#!/usr/bin/env node
// 近实时协作集成回归（服务端契约）：presence / comment / notification / SSE。
// 用法：node scripts/sync-collab-regression.mjs [--server http://127.0.0.1:8787]
//                                            [--register-code <邀请码>]
// 验证：注册→建空间→presence 心跳/在线→评论增/删→通知生成/已读/全部→
//       权限 gate→SSE 变更推送（秒级到达）。
// 有失败即非零退出。
//
// 指向线上（需邀请码）：--server https://shuyo.cn/sync --register-code <码>
// 或 SYNC_REGISTER_CODE=<码>。注意：会在目标服务端真实建用户/空间/评论。
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SERVER = (arg("--server", "http://127.0.0.1:8787") || "").replace(/\/+$/, "");
const BASE = `${SERVER}/spaces`;
// 注册邀请码：服务端配了 register_code 就必须带，否则 400。
const REGISTER_CODE = arg("--register-code", process.env.SYNC_REGISTER_CODE || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // device_id 必须每次运行都不同：服务端把 device_id 绑定到首次使用它的用户
  // （防冒充），写死的话第二次对同一服务端运行会被判 403（设备不属于你）。
  const devA = "devA-" + suffix;
  console.log(`\n[近实时协作回归] server=${SERVER}\n`);

  // 0. health
  const h = await req("GET", `${SERVER}/health`);
  ok(h.status === 200, "服务端 /health=ok");

  // 1. register A + B
  // 1. register A + B（服务端可能配了邀请码：先带码试，再退回不带码的老服务端）
  const register = async (email, display) => {
    const bodies = REGISTER_CODE
      ? [{ email, password, display, register_code: REGISTER_CODE }, { email, password, display }]
      : [{ email, password, display }, { email, password, display, register_code: "" }];
    for (const body of bodies) {
      const r = await req("POST", `${SERVER}/auth/register`, { body });
      try {
        const j = JSON.parse(r.text);
        if (j?.token) return j.token;
      } catch {
        /* 非 JSON（如 400 空体）继续尝试下一种 */
      }
    }
    return null;
  };
  const tokenA = await register(emailA, "collabA");
  ok(Boolean(tokenA), "注册用户A并取得 token");
  const tokenB = await register(emailB, "collabB");
  ok(Boolean(tokenB), "注册用户B并取得 token");
  if (!tokenA || !tokenB) {
    console.error("注册失败（若目标服务端要求邀请码，用 --register-code 或 SYNC_REGISTER_CODE 传入）。");
    console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }

  // 2. A 建空间
  const sp = JSON.parse((await req("POST", `${SERVER}/spaces`, { token: tokenA, body: { name: "近实时空间" } })).text);
  const spaceId = sp?.id;
  ok(Boolean(spaceId), "A 创建空间");

  // 3. A 邀请 B 为成员（editor）
  const mem = await req("POST", `${SERVER}/spaces/${spaceId}/members`, { token: tokenA, body: { user_email: emailB, role: "editor" } });
  ok(mem.status === 200, "A 邀请 B 为成员");

  // 4. presence 心跳 + 在线
  const beat = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/presence`, { token: tokenA, body: { page_id: "page-1", device_id: devA } })).text);
  ok(beat?.ok === true, "A presence 心跳成功");
  const online = JSON.parse((await req("GET", `${SERVER}/spaces/${spaceId}/online`, { token: tokenA })).text);
  ok(Array.isArray(online?.online) && online.online.length >= 1, `在线列表含 A（${online?.online?.length} 人）`);

  // 4b. presence 离线超时：心跳停了就该下线。
  //     服务端默认窗口 30s，直接等太慢——用 window_ms 把窗口收到 1s 来验同一段逻辑。
  await sleep(1500);
  const stale = JSON.parse((await req("GET", `${SERVER}/spaces/${spaceId}/online?window_ms=1000`, { token: tokenA })).text);
  ok(
    !(stale?.online ?? []).some((o) => o.email === emailA),
    "心跳停止超过窗口后从在线列表消失（离线超时）",
  );

  // 5. 评论添加 + 列表
  const c1 = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenA, body: { body: "评论A @ " + emailB, mentions: [] } })).text);
  ok(Boolean(c1?.id), "A 添加评论");
  const comments = JSON.parse((await req("GET", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenB })).text);
  ok(Array.isArray(comments?.items) && comments.items.length === 1, "B 拉到评论列表（1 条）");
  // 评论要能显示「谁说的」：只给 author_id 的话界面只能渲染一串十六进制，
  // 而在线成员列表却能显示邮箱，两边不一致。
  ok(comments?.items?.[0]?.author_email === emailA, `评论带可读作者邮箱（实际 ${comments?.items?.[0]?.author_email}）`);

  // 6. 通知生成（@ 成员）+ 列表 / 已读 / 全部
  const c2 = JSON.parse((await req("POST", `${SERVER}/spaces/${spaceId}/pages/page-1/comments`, { token: tokenA, body: { body: "mention B", mentions: [emailB] } })).text);
  ok(Array.isArray(c2?.notifications) && c2.notifications.length >= 1, "@B 生成通知");
  const notifs = JSON.parse((await req("GET", `${SERVER}/notifications`, { token: tokenB })).text);
  // 通知文案要说明「是谁 @ 的」，否则收件人只看到一句「提到了你」。
  const mentionNotif = (notifs?.items ?? []).find((n) => n.kind === "mention");
  ok(mentionNotif?.actor_email === emailA, `通知带触发者邮箱（实际 ${mentionNotif?.actor_email}）`);
  ok(
    typeof mentionNotif?.text === "string" && mentionNotif.text.includes(emailA),
    `通知文案含触发者（实际 ${JSON.stringify(mentionNotif?.text)}）`,
  );
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

  // 8. P1.5 SSE：B 订阅变更流 → A 推一次改动 → B 应在秒级内收到事件
  //
  // 这是「近实时」唯一的端到端证据：前面所有断言都是请求-响应式的，谁也不会
  // 暴露「服务端不主动推」这件事。真正会让它静默失效的是反向代理——
  // nginx 默认 proxy_buffering on 会把事件攒在缓冲区里不发，而 /health、
  // 鉴权、普通 API 全部正常，只有真机长连接上才看得出来。
  const sseCtrl = new AbortController();
  const sseRes = await fetch(`${SERVER}/spaces/${spaceId}/changes-stream`, {
    headers: { Authorization: `Bearer ${tokenB}` },
    signal: sseCtrl.signal,
  }).catch(() => null);
  ok(sseRes?.status === 200, `B 订阅变更流成功（HTTP ${sseRes?.status}）`);
  const ctype = sseRes?.headers.get("content-type") || "";
  ok(ctype.includes("text/event-stream"), `SSE Content-Type=text/event-stream（实际 ${ctype || "—"}）`);

  let eventAt = null;
  let rawSse = "";
  const waitEvent = (async () => {
    if (!sseRes?.body) return;
    const reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rawSse += dec.decode(value, { stream: true });
      // 只看 data: 帧；axum 的 KeepAlive 发的是注释行（":"），不算事件。
      if (rawSse.includes("data:")) { eventAt = Date.now(); break; }
    }
  })().catch(() => {});

  // 订阅是连接建立后才挂到服务端 broadcast 上的，给它一点时间再触发变更。
  await sleep(700);
  const pushSentAt = Date.now();
  const pushed = await req("POST", `${SERVER}/push`, {
    token: tokenA,
    body: {
      device_id: devA,
      space_id: spaceId,
      changes: [{
        device_seq: 1, entity: "page", entity_id: "page-sse",
        op: "upsert", payload: "{}", updated_at: Date.now(),
      }],
    },
  });
  ok(pushed.status === 200, `A 推送一次变更成功（HTTP ${pushed.status}）`);

  await Promise.race([waitEvent, sleep(8000)]);
  const latency = eventAt === null ? null : eventAt - pushSentAt;
  ok(eventAt !== null, `B 收到变更推送（${latency === null ? "8s 内未收到，超时" : latency + "ms"}）`);
  ok(latency !== null && latency < 3000, `推送延迟 < 3s（实际 ${latency === null ? "—" : latency + "ms"}）`);

  // 客户端 useSyncStream 的切帧方式是 `buf.split("\n\n")`，所以帧分隔符必须是
  // **纯 LF 空行**。若服务端或中间层改成 CRLF（\r\n\r\n），服务端照常在推、
  // 客户端永远切不出帧、两边日志都干干净净——把这条隐式契约钉在这里。
  ok(rawSse.includes("\n\n"), "帧分隔符是 LF 空行（客户端 split(\"\\n\\n\") 能切出帧）");
  ok(!rawSse.includes("\r\n"), "帧分隔符不是 CRLF（CRLF 会让客户端切不出帧）");
  ok(
    rawSse.split("\n\n").some((f) => f.includes("data:")),
    "按客户端的方式切帧确实能取到 data 帧",
  );
  sseCtrl.abort();

  console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
  if (fail) { console.error("近实时协作回归未通过。"); process.exit(1); }
  console.log("近实时协作回归全部通过 ✅");
}

main().catch((e) => { console.error("近实时协作回归异常:", e); process.exit(1); });
