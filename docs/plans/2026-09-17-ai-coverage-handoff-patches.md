# 「全库 AI 覆盖」——被"本机不能自验"卡住的三项：**可套用补丁草案**

> 配套：主方案 `2026-09-17-knowledge-base-ai-coverage-plan.md` 的 **§8.0（现状台账）/ §8.1（施工单）**。
> 本文件的用途：让**有 `cargo test` 的那一侧**照抄即可，不必从"为什么绕开它"的文字里重新推导。
> 2026-09-17，Windows 侧。

## 0. 三条**已核实**的事实（不是推测；核实方法见 §5）

1. **`capabilities.json` 的 22 条能力，每一條都声明了 `"rust": "cap_xxx"`** —— 没有例外。
2. **新增一条能力要动 6 处**。我把草案条目临时写进注册表跑门禁，它一次列全（原文）：
   ```
   ✗ 生成物与 capabilities/capabilities.json 不一致：capabilities/plugin-api-shim.js,
     src-tauri/src/capabilities_gen.rs, packages/plugin-types/index.d.ts,
     docs/plugin-api.md, src/lib/capabilities/aiTools.meta.ts
   ✗ 能力 files.read 暴露给 AI，但 src/lib/capabilities/frontend.ts 里没有它的前端实现
   ✗ 能力 files.read 没有出现在生成的 AI 工具元数据里
   ✗ 能力 files.read 声明的实现 fn cap_files_read 在 src-tauri/src/plugins.rs 里找不到
   ✗ 能力 files.read 没有出现在作者文档 docs/plugin-api.md 里
   ✗ 能力 files.read 在 dispatch 里没有分支（注册表说有，代码里没有）
   ```
3. **给既有能力加参数**（以 `pages.get` 加 `offset`/`limit` 实测）：
   - 生成物只有 **4 个 TS/文档**文件会变，**`capabilities_gen.rs` 不在其中** ⇒ 这一改动**不产生 Rust 生成物 diff**；
   - 但门禁会报：`能力 pages.get 声明了参数 offset，但 dispatch 里根本没读它（作者照文档传了也没用）`
     ⇒ **仍要改 Rust**。那个 "dispatch" = **`src-tauri/src/plugins.rs` 里的 `let out = match cap.id {`**（`check-capabilities.mjs:162` 就是按这个锚点切的）。

⇒ **依赖顺序**：**③ `db.rs` 的派生表必须先落**（否则 `cap_files_read` 无从读起）；
**① `files.read` / ② `files.search` 依赖 ③**；**④ `pages.get` 分页可独立**（不必等 ③）。

## 1. 草案 ④：`pages.get` 支持 `offset` / `limit`（**可独立做**）

**为什么**：现在硬截 6000 字且无翻页（`frontend.ts`），50 页制度只能读到开头。
⚠️ **纯 TS 那一半我已经落了一半**（不碰注册表）：截断**不再只补一个 `…`**，
改为显式 `truncated` / `chars_total` / `chars_returned` / `note`（并告诉模型去 `pages.search`）。
剩下的是"真的能翻页"。

**改动 1 —— `capabilities/capabilities.json` 的 `pages.get` 条目，`args` 追加**：

```json
{ "name": "offset", "type": "number", "required": false, "default": 0,
  "desc": "从第几个字开始（默认 0）" },
{ "name": "limit",  "type": "number", "required": false, "default": 6000,
  "desc": "最多返回多少字（上限 20000）" }
```

**改动 2 —— `src-tauri/src/plugins.rs` 的 dispatch arm**（按既有写法，与 `cap_pages_search` 同构）：

```rust
"pages.get" => {
    let id = arg_str("id")?;
    let offset = arg_i64("offset", 0).max(0) as usize;
    let limit = arg_i64("limit", 6000).clamp(1, 20_000) as usize;
    // …读页面正文后：text.chars().skip(offset).take(limit)…
}
```
> ⚠️ 具体取值函数名以 `plugins.rs` 里既有的为准（`arg_str` / `arg_opt_str` / `arg_i64` ——
> 这三个名字来自 `check-capabilities.mjs` 的注释，**不是我读遍 `plugins.rs` 得到的**）。

**改动 3 —— `src/lib/capabilities/frontend.ts` 的 `pages.get`**：把现在写死的 `PAGE_TEXT_LIMIT` 换成
`offset`/`limit` 切片，并**保留** `truncated`/`chars_total`/`note` 那套（`chars_returned` 要按实际切片长度算，
不是按 `limit` 算 —— 越界时它们不等）。

**改动 4**：`node scripts/gen-capabilities.mjs` → `node scripts/check-capabilities.mjs`。

**验收**：
- `offset=6000&limit=6000` 拿到的第二段与原文 `slice(6000, 12000)` **逐字相同**；
- `offset` 超过总长 ⇒ 返回空串 + `truncated:false` + `chars_returned:0`（**不报错**）；
- `limit` 超过 20000 ⇒ 被夹到 20000（与注册表 desc 一致）；
- 门禁双绿：`check-capabilities` + `check-web-commands`。

## 2. 草案 ①：`files.read`（**依赖 ③**）

**为什么不能省**：现在 AI 唯一能看到附件的途径是 `files.list`，而它**明确"不含文件字节"**。
P1 把文本抽出来了、P2 把块切好了，但**AI 读不到它** —— 这正是 P1 交付里"`pages.search` 与嵌入链同时命中派生文本；新增 `files.read`"那一句。

**改动 1 —— 注册表条目**（`permission` 复用既有的 `read:files`；我实测过它存在且被 `files.list` 使用）：

```json
{
  "id": "files.read",
  "title": "读取附件派生文本",
  "kind": "read",
  "scope": "current-space",
  "permission": "read:files",
  "since": "1.0.0",
  "jsPath": ["files", "read"],
  "args": [{ "name": "id", "type": "string", "required": true, "desc": "附件 id" }],
  "returns": {
    "type": "object",
    "ts": "{ id: string; segments: { kind: string; text: string; loc: string }[]; coverage: { complete: boolean; note?: string } } | null",
    "desc": "派生文本段 + 覆盖度；不存在返回 null"
  },
  "rust": "cap_files_read",
  "desc": "读取某个附件的派生文本（抽取结果）。参数: id (必填)。**不含 coverage 时不要把它当成「文件里没有」**。",
  "ai": true
}
```

**改动 2 —— `frontend.ts` 的适配器**（这一段是**可以照抄的关键**）：

```ts
"files.read": async (args) => {
  const id = String(args.id ?? "");
  if (!id) return { ok: false, error: "files.read 需要 id" };
  const rows = await api.readAttachmentText(id);   // ← 需要 ③ 先提供这条读取路径
  if (rows === null) return { ok: true, file: null };   // 不存在与"抽不出"是两回事
  const segments = rows.map((r) => ({ kind: r.kind, text: r.text, loc: r.loc }));
  return {
    ok: true,
    file: {
      id,
      segments,
      // ⚠️ **必须带覆盖度**：否则"我没抽到"会被读成"文件里没有" ——
      //    这与 §15.10 用 ExtractCoverage 防的是同一件事，只是发生在 AI 工具面。
      coverage: { complete: rows.every((r) => r.coverageComplete !== false) },
      ...(rows.length === 0
        ? { note: "该附件没有派生文本：可能没有抽取器认领这种格式、抽取失败、或还没跑过抽取。不要据此断言文件里没有相关内容。" }
        : {}),
    },
  };
},
```

**改动 3 / 4**：`plugins.rs` 加 `cap_files_read` + dispatch arm；`node scripts/gen-capabilities.mjs`；
`node scripts/check-capabilities.mjs`。

**验收**：
- 抽过的附件：`segments` 与库里 `attachment_text` 的行**逐字一致**（含 `kind` / `loc`）；
- **没抽过的附件**：`segments: []` + `note`（**不是** `ok:false` —— "没内容"与"调用失败"要分开，同 §15.10 的口径）；
- 不存在的 id：`file: null`；
- 门禁双绿。

## 3. 草案 ②：`files.search`（**依赖 ③ + ④ 的检索侧**）

**交付定义在 P2**："BM25 + 向量混合与重排；`files.search` 工具"。
⚠️ **这一条与 Mac 正在做的检索侧重叠** —— **请以他们的接口为准**（他们已认领 `search.rs` / 混合检索 / `files.search`）。
我这里只记一条**不要漏**的约束：它必须**同时覆盖页面块与附件块**（`chunks` 有两类 owner：
`page_id` 与 `att_id`）—— 否则会变成"全库搜得到、附件搜不到"。

## 4. 草案 ③：`db.rs` 的派生表（**其余三项的前置**）

- **DDL 单一事实源是 `src/lib/extract/schema.ts` 的 `DERIVED_SCHEMA_DDL`**（三条 `CREATE TABLE` + 两条 `CREATE INDEX`，**每条是单语句**）。
  Rust 侧照抄，并**加一条一致性断言**（与 §7 的验收项对齐）：
  两边的建表语句**文本级一致**，避免"同一份数据在两个平台上读不出来"。
  > 这不是洁癖：`sqliteStore.ts` 已经改成**直接 import 这份 DDL** 执行；Rust 只能照抄 ⇒
  > **一致性断言是唯一能防漂移的手段**。
- **语义对齐既有实现**：`attachment_text` 的 `src_hash` 失效口径、`replace` 的整体替换、
  `chunks` 的 `id = <ownerKey>#<ord>` + `hash = fnv1a32(text)`。
  ⚠️ **`fnv1a32` 必须与 TS 侧逐字一致**（`src/lib/hash.ts`）—— 有一条 TS 判据断言它与既有 `embedHash` 同值，
  Rust 侧请照抄那段算法并加同样的对拍。

## 5. 我**验证到什么程度**、以及**不能验什么**

| 事项 | 我做到 | 证据 |
|---|---|---|
| "22 条能力都有 rust 函数" | 用 node 解析注册表统计 | 输出 `能力总数: 22 / 没有 rust 字段的: 0` |
| "新增能力要动 6 处" | **临时**把草案写进注册表 → 跑门禁 → 撤销 | 门禁原文（§0.2），工作区已恢复干净 |
| "加参数不产生 Rust 生成物 diff，但仍要改 dispatch" | **临时**给 `pages.get` 加参数 → 跑门禁 → 撤销 | 门禁原文（§0.3） |
| "dispatch 是 `plugins.rs` 的 `match cap.id`" | 读 `check-capabilities.mjs:162` 的锚点 | 源码 |
| **Rust 代码能不能编过** | ❌ **不能**（本机 `cargo test` 跑不了，`0xc0000139`，§12.1） | — |
| **`plugins.rs` 里 `arg_*` 的准确函数名** | ⚠️ 只从 `check-capabilities.mjs` 的注释得知，**没有读遍 `plugins.rs`** | 请在实现时以文件为准 |

> 结论：**本文件里的 TS/JSON 部分可以照抄；Rust 部分是"形状 + 验收"，请以实现时的文件为准。**
> 我把不能验的部分**单独列出来**，而不是混在"已经做好"里 —— 那正是别人复核时最需要知道的一段。
