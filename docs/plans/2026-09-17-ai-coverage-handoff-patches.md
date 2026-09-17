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

**为什么不能省**：AI 现在唯一的附件途径是 `files.list`（**明确"不含文件字节"**）与 `files.search`
（只回**片段**）。⇒ "搜得到片段，但没法把某个附件的正文整段读出来"。
P1 把文本抽出来了、P2 把块切好了，但 **AI 读不到它** —— 这正是 P1 交付清单里那句"新增 `files.read`"。

**⚠️ 这条草案已在 2026-09-17 更新：`files.search` 已由 Mac 侧落地，它就是这个功能的现成模板。**
下表是我**读代码核到的**实际落点（不是推测），照它逐层加一处即可：

| 层 | `files.search` 的落点（模板） | `files.read` 对应要加什么 |
|---|---|---|
| 注册表（单一事实源） | `capabilities/capabilities.json`（`files.search` 条目，`since: "1.1.0"`、`permission: "read:files"`、`ai: true`） | 一条 `files.read` 条目（见"改动 1"） |
| 生成物 | 跑 `node scripts/gen-capabilities.mjs`（会写 `plugin-api-shim.js` / `capabilities_gen.rs` / 类型包 / 作者文档 / `aiTools.meta.ts`） | 同上，重新生成 |
| 前端适配 | `src/lib/capabilities/frontend.ts:128` | 同文件加 `"files.read"` 适配器（改动 2） |
| api 层 | `src/lib/api.ts:425` `searchChunks` | 加 `readAttachmentText`（改动 3） |
| 命令面 | `src/lib/platform/commands.ts:374` `search_chunks` | 加 `read_attachment_text`（改动 3） |
| Web 实现 | `web.ts` 里的同名分支 | 同构加一处（**我没有逐行读它，请以文件为准**） |
| Rust 能力 fn | `src-tauri/src/plugins.rs:1848` `fn cap_files_search(query, limit) -> CapResult` | 加 `cap_files_read`（改动 4） |
| Rust dispatch | `plugins.rs:2074` `"files.search" => cap_files_search(&arg_str("query")?, arg_i64("limit", 10)),` | 加一行 arm（改动 4） |
| **Rust 读取** | **复用** `search.rs:821` 的 `search_chunks_in_conn` | ⚠️ **这是唯一"新东西"**：需要一个按 `attId` 读 `attachment_text` 的函数（改动 4） |

> **一句话**：八层里七层是照抄，**唯一要新写的是 Rust 侧那个 reader**。这也是为什么它值一条草案
> 而不是一句"你去加个 files.read 吧"。

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

**改动 3 —— `api.ts` + `commands.ts`**（照 `searchChunks` / `search_chunks` 的形状）：

```ts
// api.ts（紧邻 searchChunks）
readAttachmentText: (id: string, offset = 0, limit = 200) =>
  invoke("read_attachment_text", { args: { id, offset, limit } }),

// commands.ts
/** 读某个附件的派生文本（**只读** `attachment_text`）。⚠️ 分页：一篇 PDF 可能有上千段，
 *  一次性返回会撑爆模型上下文 —— 所以带 offset/limit，并如实回报 total/truncated。 */
read_attachment_text: {
  args: { args: { id: string; offset?: number; limit?: number } };
  result: { segments: { kind: string; text: string; loc: string }[]; total: number } | null;
};
```

**改动 4 —— `plugins.rs` 两处 + 一个新的 Rust reader**：

```rust
// 与 cap_files_search 同构：只读、走活动空间
fn cap_files_read(id: &str, offset: i64, limit: i64) -> CapResult {
    if id.is_empty() { return Err("bad_args: id 不能为空".to_string()); }
    let (off, lim) = (offset.max(0) as usize, limit.clamp(1, 1000) as usize);
    // ⚠️ 这个函数是**本草案唯一的新东西**（`search.rs` 里没有按 att_id 读的现成函数）：
    //    它应当 `ORDER BY seq` 读 `attachment_text`，并**返回 total**（总段数）——
    //    没有 total 就没法告诉调用方"你只看到了一部分"（§15.10 的同一条原则）。
    let page = with_read_conn(|c| crate::search::read_attachment_text_in_conn(c, id, off, lim))?;
    serde_json::to_value(&page).map_err(|e| format!("internal: {e}"))
}

// dispatch（紧邻 files.search 那行）
"files.read" => cap_files_read(&arg_str("id")?, arg_i64("offset", 0), arg_i64("limit", 200)),
```

⚠️ **`arg_*` 的准确取值函数与 `CapResult` 的形状以 `plugins.rs` 现有写作为准**（我是从 `cap_files_search`
那一行读到的这三个名字，**没有读遍该文件**）。`read_attachment_text_in_conn` 是**我建议的新函数**，
需要在 `search.rs` 里新写（或放进合适的位置）—— 请以实现时的结构为准。

**验收**：
- 抽过的附件：`segments` 与库里 `attachment_text` 的行**逐字一致**（含 `kind` / `loc`，且 `ORDER BY seq`）；
- **没抽过的附件**：`segments: []` + `total: 0` + `note`（**不是** `ok:false` —— "没内容"与"调用失败"要分开，同 §15.10 的口径）；
- 不存在的 id：`file: null`；
- **分页**：`offset=limit` 夹到 1..1000、越界 offset ⇒ 空数组 + 真实 `total`（**不报错**，且**绝不返回全库**）；
- **老库没有 `attachment_text` 表 ⇒ 空数组 + total 0（不是报错）** —— 照 `files.search` 那条"缺表向前兼容"判据的写法；
- 生成物一致 + `check-capabilities` + `check-web-commands` 双绿 + `cargo test`。

**我验证到什么程度**：上表的落点是**读代码核到的**（注册表条目原文、`frontend.ts:128`、`api.ts:425`、
`commands.ts:374`、`plugins.rs:1848`/`:2074`、`search.rs:821`）。**我没有写这个功能、也没有编译过 Rust**
（本机跑不了 `cargo test`）—— 所以 Rust 部分请以文件为准，TS 部分可照抄。

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
