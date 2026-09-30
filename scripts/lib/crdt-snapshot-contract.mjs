// CRDT 加密快照的**服务端接口契约表**（单一事实来源）
//
// 为什么是一张表、而不是写在服务端代码里：
//   施工单 `docs/plans/2026-09-29-crdt-e2ee-snapshot-server-workorder.md` §2 定了三条路由 ✓，
//   但**实现落在 `shuyonote-sync-server`**（另一个仓、商业组件）⇒ 契约必须先在本仓**可核** ✓
//   ⇒ 服务端实现时**契约先红再绿**（与 `INV-CRDT-*` 同一种做法 ✓）。
//
// 三条不许退化的规则（本表的"承重"部分 ✓，每条都对应一次**不可逆**后果）：
//   ① `serverMustNotParse` —— 服务端**不许解析**快照内容（它是密文）✗
//      反例后果：一旦解析/索引，个人空间的"服务端在数学上无法解密"就名存实亡 ✓
//   ② `retireAfterSnapshot` —— **先落快照、再退役 `seq <= snapshotSeq` 的旧 blob** ✗
//      反例后果：顺序反了就是**不可逆的数据丢失**（新设备再也拼不回来）✓
//   ③ `snapshotSeqRequiredAndMonotonic` —— `snapshotSeq` **必填且单调不减** ✗
//      反例后果：可选 ⇒ 服务端不知道快照覆盖到哪 ⇒ 退役无从判断（静默丢数据）✓
//   ＋ 下载幂等：同一份密文重复 GET 必须得到同一份 ✓（重试安全 ✓）

/** 三条路由（写死的契约；改它就要改服务端 ＋ 本门禁的夹具 ✓） */
export const SNAPSHOT_ROUTES = [
  {
    id: 'upload-snapshot',
    method: 'PUT',
    path: '/spaces/:id/snapshot',
    body: { snapshot: 'opaque-bytes', snapshotSeq: 'required', format: 'opaque' },
    note: '收一个**不透明密文 blob** ＋ 它覆盖到哪一条（snapshotSeq）✓',
  },
  {
    id: 'download-snapshot',
    method: 'GET',
    path: '/spaces/:id/snapshot',
    body: {},
    note: '幂等：新旧设备拿到同一份密文 ✓（重试安全 ✓）',
  },
  {
    id: 'retire-old-deltas',
    method: 'DELETE',
    path: '/spaces/:id/deltas?upto=:snapshotSeq',
    body: { upto: 'required' },
    note: '**只在快照已收妥之后**才允许调用 ✓（顺序＝承重 ✓）',
  },
];

/** 承重规则（名字就是判据 ✓） */
export const SNAPSHOT_RULES = {
  serverMustNotParse: true,
  retireAfterSnapshot: true,
  snapshotSeqRequiredAndMonotonic: true,
  downloadIdempotent: true,
  serverHoldsNoKeys: true,
};

/**
 * 纯判据：拿一张契约 ⇒ findings（空数组＝干净 ✓）
 * ⚠️ 刻意做成**纯函数**（不读盘、不起进程）⇒ 夹具直接构造对象就能测 ✓（与 `--self-test` 一致 ✓）
 */
export function validate(contract) {
  const out = [];
  const c = contract || {};
  const routes = Array.isArray(c.routes) ? c.routes : [];
  const rules = c.rules || {};
  const need = ['upload-snapshot', 'download-snapshot', 'retire-old-deltas'];
  const have = new Set(routes.map((r) => r && r.id));
  for (const id of need) if (!have.has(id)) out.push('✗ 缺路由：' + id + '（三条路由是契约，少一条服务端就实现不全 ✗）');
  const up = routes.find((r) => r && r.id === 'upload-snapshot');
  if (up) {
    if (!up.body || up.body.snapshotSeq !== 'required') out.push('✗ `snapshotSeq` 必须**必填**（改成可选 ⇒ 服务端不知道快照覆盖到哪 ⇒ 退役静默丢数据 ✗）');
    if (!up.body || up.body.snapshot !== 'opaque-bytes') out.push('✗ `snapshot` 必须是**不透明字节**（`format: opaque` ✓ —— 服务端不许解析 ✗）');
    if (up.body && up.body.format !== 'opaque') out.push('✗ upload 的 `format` 必须是 `opaque`（不许声明成可解析结构 ✗）');
  }
  const ret = routes.find((r) => r && r.id === 'retire-old-deltas');
  if (ret && (!ret.body || ret.body.upto !== 'required')) out.push('✗ 退役路由的 `upto` 必须**必填**（否则退役范围不明 ✗）');
  for (const k of Object.keys(SNAPSHOT_RULES)) {
    if (rules[k] !== true) out.push('✗ 承重规则 `' + k + '` 必须为 true（现在＝' + String(rules[k]) + ' ✗）—— 见本文件头部的反例后果 ✓');
  }
  return out;
}
