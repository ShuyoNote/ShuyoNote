#!/usr/bin/env node
// check-crdt-snapshot-contract.mjs —— CRDT 加密快照的**服务端接口契约**不许退化（2026-09-29 立）
//
// incident（仓规：每条门禁都要写它挡的是哪次真实事故 ✓）：
//   2026-09-29 盘点 CRDT 阶段 2 时发现：E2EE 加密快照的**协议可行性已验**（尖刺 §4：13 通过 / 0 失败 ✓），
//   但**服务端接口这一半没写下来** ✗ —— 只有散文式的施工单
//   （`docs/plans/2026-09-29-crdt-e2ee-snapshot-server-workorder.md`），
//   而实现落在**另一个仓**（`shuyonote-sync-server`，商业组件）⇒ 契约一旦在口头/散文里，
//   服务端实现时最容易退化的恰恰是**不可逆**的那三条：
//     ① 服务端开始"解析"快照（它是密文）⇒ 个人空间"服务端在数学上无法解密"名存实亡 ✗
//     ② 先退役旧 blob、后落快照 ⇒ **不可逆的数据丢失**（新设备再也拼不回来）✗
//     ③ `snapshotSeq` 从必填变可选 ⇒ 服务端不知道快照覆盖到哪 ⇒ 退役范围不明（静默丢数据）✗
//   ⇒ 本门禁把这三条连同两条辅助规则钉在代码里：**服务端实现时契约先红再绿** ✓
//
// 判据：`scripts/lib/crdt-snapshot-contract.mjs` 的 `validate()` 无 findings ✓（纯函数，夹具直接构造对象 ✓）
// 退出码：0 干净 ／ 1 有发现 ／ 2 读不到契约表（**不算通过** ✓）
// 用法：node scripts/check-crdt-snapshot-contract.mjs ／ --self-test

import { SNAPSHOT_ROUTES, SNAPSHOT_RULES, validate } from './lib/crdt-snapshot-contract.mjs';

const argv = process.argv.slice(2);

if (argv.includes('--self-test')) {
  const clean = { routes: SNAPSHOT_ROUTES, rules: SNAPSHOT_RULES };
  const mk = (over) => ({ routes: over.routes || SNAPSHOT_ROUTES, rules: Object.assign({}, SNAPSHOT_RULES, over.rules || {}) });
  // ① 缺一条路由 ⇒ 红
  const missing = mk({ routes: SNAPSHOT_ROUTES.filter((r) => r.id !== 'retire-old-deltas') });
  // ② snapshotSeq 变可选 ⇒ 红
  const optionalSeq = mk({ routes: SNAPSHOT_ROUTES.map((r) => (r.id === 'upload-snapshot' ? { ...r, body: { ...r.body, snapshotSeq: 'optional' } } : r)) });
  // ③ 服务端可解析 ⇒ 红
  const parseable = mk({ routes: SNAPSHOT_ROUTES.map((r) => (r.id === 'upload-snapshot' ? { ...r, body: { ...r.body, format: 'json' } } : r)) });
  // ④ 顺序规则被关掉 ⇒ 红
  const noOrder = mk({ rules: { retireAfterSnapshot: false } });
  const cases = [
    ['真契约 ⇒ 干净', validate(clean).length === 0],
    ['缺一条路由 ⇒ 红', validate(missing).some((s) => s.includes('缺路由'))],
    ['`snapshotSeq` 变可选 ⇒ 红', validate(optionalSeq).some((s) => s.includes('必填'))],
    ['服务端可解析（format=json）⇒ 红', validate(parseable).some((s) => s.includes('opaque'))],
    ['「先落快照」规则被关 ⇒ 红', validate(noOrder).some((s) => s.includes('retireAfterSnapshot'))],
    ['空契约 ⇒ 红（不许当干净 ✗）', validate({}).length > 0],
  ];
  let pass = 0;
  for (const [n, ok] of cases) { console.log((ok ? '  ✓ ' : '  ✗ ') + n); if (ok) pass++; }
  console.log('self-test: ' + pass + '/' + cases.length + ' 通过');
  process.exit(pass === cases.length ? 0 : 1);
}

if (!Array.isArray(SNAPSHOT_ROUTES) || SNAPSHOT_ROUTES.length === 0) {
  console.error('✗ 读不到契约表（routes 为空）⇒ **不算通过** ✓');
  process.exit(2);
}
const findings = validate({ routes: SNAPSHOT_ROUTES, rules: SNAPSHOT_RULES });
console.log('  契约：路由 ' + SNAPSHOT_ROUTES.length + ' 条（' + SNAPSHOT_ROUTES.map((r) => r.id).join(' / ') + '）｜ 承重规则 ' + Object.keys(SNAPSHOT_RULES).length + ' 条 ✓');
if (findings.length) { for (const f of findings) console.error(f); process.exit(1); }
console.log('✓ 加密快照的服务端接口契约完整：三条路由齐 ✓、`snapshotSeq` 必填 ✓、快照不透明 ✓、先落快照再退役 ✓、下载幂等 ✓、服务端不持密钥 ✓');
