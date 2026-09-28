# 规格：知识层与外部接入（RAG · LLM Wiki · Ontology · MCP）

> 需求（原话与读数）在 [`2026-09-28-knowledge-and-agent-access-requirements.md`](2026-09-28-knowledge-and-agent-access-requirements.md) ✓
> 方案（架构与取舍）在 [`../plans/2026-09-28-knowledge-and-agent-access-plan.md`](../plans/2026-09-28-knowledge-and-agent-access-plan.md) ✓
> **本文件只管"必须一直成立的事"**（每条挂一条会红的判据，或显式写"判据待立" ✗）✓

## 0. 字段口径（与 `INVARIANTS.md` 同形，便于将来机器迁移）

| 字段 | 含义 |
|---|---|
| id | `INV-KB-*`（KB＝knowledge base） |
| 口径 | 一句话，**必须一直成立** |
| 判据 | 要立的那条检查（跑什么、看什么） |
| 会红证据 | **怎么让它红**（再注入 ＋ 逐字预期） |
| 今天能跑吗 | `能` ＝ 已有可跑判据 ／ `待立` ＝ 判据还没写出来（**不算通过** ✗） |
| 承重渠道 | 判据在哪跑：`本机 Node` ／ `Rust/CI` ／ `人`（人判的要写理由 ✓） |

## 1. 本规格要解决的**一个口径问题**（比下面十条更根本）

```text
今天："能力注册表"（capabilities/capabilities.json，25 条）只是**App 内部的结构描述** ✓
加了外部接入（MCP）后：同一份东西同时是**第三方依赖的接口** ✓
⇒ **口径问题**：它到底是"派生物"还是"契约"？
⇒ 答案：**两者都是，但只许有一份源** —— 源是注册表 ✓；本体表、工具清单、知识地图**都是它的生成物** ✗
   ⇒ 由此直接长出 §2 的第 1 条（生成物）与第 2 条（改了就升版本）✓
```

## 2. 不变式

| id | 口径（一句话） | 判据（要立的那条） | 会红证据（再注入） | 今天能跑吗 | 承重渠道 |
|---|---|---|---|---|---|
| **INV-KB-ontology-generated** | **本体表是注册表的生成物，不许手写第二份** | ⚠️ **与 `INV-MCP-tools-generated` 同源**（同一个生成器 ⇒ 判据合并立一条 ✓） | 手改本体表一行 ⇒ 对账红 ✓ | 待立 | 本机 Node |
| **INV-KB-apiversion-bump** | **改 id／删能力／改语义 ⇒ 必须 bump `apiVersion`** | 生成物指纹 vs `apiVersion`：指纹变了而版本没变 ⇒ 红 | 删掉 `tags.list` 不升版本 ⇒ 红 ✓ | 待立 | 本机 Node |
| **INV-KB-readonly-surface** | **只读面（M1）里 `kind === 'write'` 的条数 = 0** | ⚠️ **归属 `INV-MCP-readonly-first`**（不在本表重复 ✗） | 往 M1 清单塞 `pages.create` ⇒ 红 ✓ | 待立 | 本机 Node |
| **INV-KB-tool-desc-clean** | **工具描述里不出现仓内路径与内部字段名** | 扫生成物描述串：命中 `src/`、`content_json`、`workspace_id` 等 ⇒ 红 | 描述里写 `` `content_json` `` ⇒ 红 ✓ | 待立 | 本机 Node |
| **INV-KB-space-split** | **个人空间一分内容不出本机；团队空间按已声明口径** | 个人侧的网络目标清单必须为空；团队侧逐条对 `docs/sync-server-data-boundary.md` | 给个人侧加一个 http 目标 ⇒ 红 ✓ | **待立**（个人侧可机检；团队侧需人核） | 人 ＋ 本机 Node |
| **INV-KB-audit-subject** | **审计能区分「人／插件／外部 Agent」三类主体** | ⚠️ **与 `INV-MCP-single-authz` 相关**，但"主体标识"是**新增**的（不在其内 ✓） | 把主体字段写死成一类 ⇒ 红 ✓ | **待立**（前置未定） | Rust/CI |
| **INV-KB-single-semantics** | **外部经桥与 App 内走同一校验点、同一过滤语义**（软删／工作空间／`content_json` 收口） | ⚠️ **归属 `INV-MCP-single-authz`**（不在本表重复 ✗） | 让桥自己写一遍过滤（少一个软删条件）⇒ 红 ✓ | 待立 | 本机 Node ＋ Rust |
| **INV-KB-derived-rebuildable** | **索引／wiki／地图都是派生物，可重建** | 删索引 ⇒ 功能不降级（只是慢）；重建后**同一查询同结果集** | 让索引成为唯一真相（删了就查不到）⇒ 红 ✓ | 待立 | 本机 Node |
| **INV-KB-citation-stale** | **生成物每条断言带回链；源一改即标脏；页脚写「派生，非出处」** | 三条各一机检：回链可达 ／ 源 sha 变 ⇒ 页面标脏 ／ 页脚串存在 | 改一个源文件不标脏 ⇒ 红 ✓ | 待立 | 本机 Node |
| **INV-KB-locked-loud** | **锁定/未解锁 ⇒ 明确报错，不许返回空结果** | ⚠️ **归属 `INV-MCP-locked-fails-loud`**（不在本表重复 ✗） | 让锁定路径返回 `[]` ⇒ 红 ✓ | 待立（与 MCP 那条合并立） | Rust/CI |

> ⚠️ **本表今天"能跑"的是 0 条** —— 这不是坏事，是**如实**：规格层存在的前提就是"先立判据" ✓
> ⇒ 收录进 `INVARIANTS.md` 的三条件（能指到会红判据 ／ 看过它红 ／ 能原地重做）**一条都还没满足** ✗

## 3. 落地顺序（**先让判据能跑，再进 `INVARIANTS.md`**）

> ⚠️ **去重口径（2026-09-28 加）**：本表**不重复** `INV-MCP-*` 已有的条目；
> 与外部接入相关的，**归属**那份规格（`2026-09-28-mcp-host-spec.md` ✓），本表只**引用** ✓
> （判据：同一条 `INV-` 只出现在一份规格里 ✗）

```text
第 1 步  纯 Node 三个（本机可跑，零依赖）：ontology-generated ／ readonly-surface ／ tool-desc-clean
         ⇒ 再注入：手改本体一行 ／ 塞写能力 ／ 描述里写内部字段名
第 2 步  再加三个：apiversion-bump ／ citation-stale ／ derived-rebuildable
第 3 步  跨实现那一类：single-semantics（要能同时问两条路径 ⇒ 多半要等 M1 落地）
第 4 步  Rust/CI 那一类：locked-loud ／（以及 audit-subject —— ⚠️ 前置是**先定主体标识字段** ✗）
```

## 4. 与需求／方案的分工（防止三份互相抄）

| 文件 | 管什么 | 不管什么 |
|---|---|---|
| 需求 | 原话与读数、要什么/不要什么、边界 | 不写判据 ✗、不写架构 ✗ |
| **本规格** | **必须一直成立的事**（`INV-KB-*`） | 不写施工步骤 ✗、不写取舍理由 ✗（在方案里 ✓） |
| 方案 | 架构、分档、取舍、不做什么 | 不重写不变式 ✗（只引用 id ✓） |

## 5. 本文件**故意不含**的

1. **施工步骤与 `Files:`** ⇒ 在施工单里 ✓
2. **测量方法**（怎么量召回率/p95/内存）⇒ 方案 §度量 ✓
3. **已存在的不变式**（MCP 那批 `INV-MCP-*`）⇒ **不复制** ✗，只在本表里按需引用 ✓
