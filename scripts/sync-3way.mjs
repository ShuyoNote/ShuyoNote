#!/usr/bin/env node
// 三端同步合练（mac / windows / amd）：直接打服务端 API，验"三台机器在同一个空间里能互相看见"。
//
// 为什么单独有这个脚本：`scripts/sync-multidevice.mjs`（两端会合协议）验的是**两台**机器；
// 第三台机器加入之后，"前面的两端还能不能互相看到对方的新页"没人验过。AMD 工作站接入时，
// 这是最先该跑的一条。
//
// 它**只打服务端 API**（不跑客户端核心），所以能证明的与不能证明的分开写：
//   能证明：三个设备各自的变更都进了空间、任一设备全量拉取都能看见三份、后加入的设备能补齐历史、
//           同一 (device_id, device_seq) 重推是幂等的、同页并发写时**服务端存了两条**（不合并）。
//   不能证明：客户端如何解决同页冲突（LWW 判定在客户端，属于客户端测试面——见 docs/sync-multidevice-test.md §6）。
//
// 用法：
//   node scripts/sync-3way.mjs --server http://127.0.0.1:8787 --email me@example.com --password …
//   node scripts/sync-3way.mjs --server … --token <会话 token>            # 已有会话就直接给 token
//   …--space <space_id>                                                   # 不给就取 GET /spaces 的第一个
// 退出码：0 = 全过；1 = 有断言失败（逐条打印）。

const argv = process.argv.slice(2);
const arg = (name, def = "") => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const SERVER = (arg("--server", "http://127.0.0.1:8787") || "").replace(/\/+$/, "");
const EMAIL = arg("--email");
const PASSWORD = arg("--password");
const TOKEN_ARG = arg("--token");
const SPACE_ARG = arg("--space");
const ROLES = ["mac", "windows", "amd"];
const NOW = Date.now();

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures += 1;
};

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应：下面按状态码判 */
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`[三端合练] server=${SERVER}`);

  const health = await api("/health");
  check(health.status === 200, "服务端可达（/health）", `HTTP ${health.status}`);

  let token = TOKEN_ARG;
  if (!token) {
    if (!EMAIL || !PASSWORD) {
      console.error("需要 --token，或 --email 与 --password 之一");
      process.exit(2);
    }
    const login = await api("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    token = login.json?.token ?? "";
    check(login.status === 200 && !!token, "登录成功并取得 token", `HTTP ${login.status}`);
    if (!token) process.exit(1);
  }

  let spaceId = SPACE_ARG;
  if (!spaceId) {
    const spaces = await api("/spaces", { token });
    spaceId = spaces.json?.spaces?.[0]?.id ?? "";
    check(!!spaceId, "拿到空间 id（不做 --space 时取第一个）", spaceId || `HTTP ${spaces.status}`);
    if (!spaceId) process.exit(1);
  } else {
    console.log(`  · 使用给定空间 ${spaceId}`);
  }

  // ① 三个角色各自推一页（各用自己的 device_id）
  const pages = {};
  for (const [i, role] of ROLES.entries()) {
    const entityId = `t3-${role}-${NOW}`;
    pages[role] = entityId;
    const push = await api("/push", {
      method: "POST",
      token,
      body: {
        device_id: `dev-${role}`,
        space_id: spaceId,
        changes: [
          {
            device_seq: 1 + i,
            entity: "page",
            entity_id: entityId,
            op: "upsert",
            payload: JSON.stringify({ title: `T3:${role}`, role, at: NOW }),
            updated_at: NOW + i,
          },
        ],
      },
    });
    check(push.status === 200 && push.json?.accepted === 1, `${role} 推了一页`, `HTTP ${push.status} accepted=${push.json?.accepted}`);
  }

  // ② 每个角色全量拉取，都要看见三页
  const seesAll = async (label) => {
    const pull = await api(`/pull?space_id=${encodeURIComponent(spaceId)}&since=0&limit=1000`, { token });
    const ids = new Set((pull.json?.changes ?? []).map((c) => c.entity_id));
    const seen = ROLES.filter((r) => ids.has(pages[r]));
    check(seen.length === ROLES.length, `${label} 全量拉取看得见三页`, `看见 ${seen.join("/") || "无"}（共 ${ids.size} 条变更）`);
    return ids;
  };
  await seesAll("mac 视角");
  await seesAll("windows 视角");
  await seesAll("amd 视角");

  // ③ 后加入的第四台设备（模拟 AMD 第二台机器/重装）能补齐历史
  const late = await api(`/pull?space_id=${encodeURIComponent(spaceId)}&since=0&limit=1000`, { token });
  const lateIds = new Set((late.json?.changes ?? []).map((c) => c.entity_id));
  check(
    ROLES.every((r) => lateIds.has(pages[r])),
    "后加入的设备一次全量拉取即补齐三页",
    `HTTP ${late.status}`,
  );

  // ④ 同一 (device_id, device_seq) 重推：幂等（accepted=0）
  const again = await api("/push", {
    method: "POST",
    token,
    body: {
      device_id: "dev-mac",
      space_id: spaceId,
      changes: [
        {
          device_seq: 1,
          entity: "page",
          entity_id: pages.mac,
          op: "upsert",
          payload: JSON.stringify({ title: "T3:mac", role: "mac", at: NOW }),
          updated_at: NOW,
        },
      ],
    },
  });
  check(again.status === 200 && again.json?.accepted === 0, "重推同一 device_seq 被去重", `accepted=${again.json?.accepted}`);

  // ⑤ 同页并发写：服务端**存两条**（合并策略在客户端，这里只报服务端事实）
  const shared = `t3-shared-${NOW}`;
  for (const [dev, at] of [
    ["dev-windows", NOW + 100],
    ["dev-amd", NOW + 200],
  ]) {
    await api("/push", {
      method: "POST",
      token,
      body: {
        device_id: dev,
        space_id: spaceId,
        changes: [
          {
            device_seq: 10,
            entity: "page",
            entity_id: shared,
            op: "upsert",
            payload: JSON.stringify({ title: `T3:shared-by-${dev}`, at }),
            updated_at: at,
          },
        ],
      },
    });
  }
  const after = await api(`/pull?space_id=${encodeURIComponent(spaceId)}&since=0&limit=1000`, { token });
  const sharedChanges = (after.json?.changes ?? []).filter((c) => c.entity_id === shared);
  check(sharedChanges.length === 2, "同页并发写：服务端保留两条变更（不做合并）", `共 ${sharedChanges.length} 条`);
  console.log(
    `  · 因此同页冲突的**判定在客户端**（按 updated_at 取新之类）——` +
      `本条只证明服务端事实，客户端那半属于客户端测试面，别当成"同页冲突已验"`,
  );

  console.log(failures === 0 ? "[三端合练] 全部通过 ✅" : `[三端合练] ${failures} 条未通过 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[三端合练] 异常：", e?.message ?? e);
  process.exit(1);
});
