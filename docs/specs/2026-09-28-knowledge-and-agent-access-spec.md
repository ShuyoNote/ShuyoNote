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

> ⭐ **2026-10-02**：owner 提「**考虑**让 agent 走进讨论线」⇒ 「**实例落在讨论线上**」的写法、
> 那三个新面（主体／内容流向／注入面）与 A／B 两方，记在
> [`2026-10-01-enterprise-im-spec.md`](2026-10-01-enterprise-im-spec.md) **§1.7** ✓
> （⛔ 此处**不重复正文** ✗ —— 单一出处 ✓）；本规格那几条 `INV-KB-*` **仍然是它们的正文** ✓。

## 2. 不变式

| id | 口径（一句话） | 判据（要立的那条） | 会红证据（再注入） | 今天能跑吗 | 承重渠道 |
|---|---|---|---|---|---|
| **INV-KB-ontology-generated** | **本体表是注册表的生成物，不许手写第二份** | ⚠️ **与 `INV-MCP-tools-generated` 同源**（同一个生成器 ⇒ 判据合并立一条 ✓） | 手改本体表一行 ⇒ 对账红 ✓ | **能**（`check-ontology-generated`） | 本机 Node |
| **INV-KB-apiversion-bump** | **改 id／删能力／改语义 ⇒ 必须 bump `apiVersion`** | 生成物指纹 vs `apiVersion`：指纹变了而版本没变 ⇒ 红 | 删掉 `tags.list` 不升版本 ⇒ 红 ✓ | **能**（`check-api-surface-version`） | 本机 Node |
| **INV-KB-readonly-surface** | **只读面（M1）里 `kind === 'write'` 的条数 = 0** | ⚠️ **归属 `INV-MCP-readonly-first`**（不在本表重复 ✗） | 往 M1 清单塞 `pages.create` ⇒ 红 ✓ | **能**（`check-agent-surface`；与 `INV-MCP-readonly-first` 同一条，以已实现判据为准 ✓） | 本机 Node |
| **INV-KB-tool-desc-clean** | **工具描述里不出现仓内路径与内部字段名** | 扫生成物描述串：命中 `src/`、`content_json`、`workspace_id` 等 ⇒ 红 | 描述里写 `` `content_json` `` ⇒ 红 ✓ | **能**（`check-agent-surface`） | 本机 Node |
| **INV-KB-space-split** | **个人空间一分内容不出本机；团队空间按已声明口径** | 个人侧的网络目标清单必须为空；团队侧逐条对 `docs/sync-server-data-boundary.md` | 给个人侧加一个 http 目标 ⇒ 红 ✓ | **待立**（个人侧可机检；团队侧需人核） | 人 ＋ 本机 Node |

> ⚠️ **2026-10-02 复核（macOS 侧，清个人版判据缺口时量到 ✓）—— 这条**仍然待立** ✗，但原因和「有人忘了」无关 ✓：
> · 「**个人侧的网络目标清单必须为空**」里的那份**清单**，在代码里**不存在** ✗（全仓搜「网络目标」只命中本文件与 `personal-edition-spec` 那两行 ✓）⇒ 这是**先要有那个声明面**的问题，不是补一条判据 ✓；
> · 「AI 只准本机端点」**目前只是散文** ✗（`src-tauri/src/ai.rs` 收**任意** `base_url` 并直连 ✓，`grep id: "check-ai` **零命中** ✓）；
> · ✅ **今天真正守着「桥这一层不出本机」的是三条更强的门禁**：`check-mcp-channel-judge`（默认关 ＋ 只绑回环 ＋ Origin/Host 恰好回环 ✓）／`check-mcp-host-channel` ✓／`check-mcp-host-authz`（唯一鉴权点 ✓）⇒ 「个人侧**没有可连的网络目标**」在桥这一层**今天就成立** ✓；
> ⇒ 已记为台账 **R119** —— ⚠️ **2026-10-08 已由 owner 拍板结案：处置＝「不做」（维持现状）**
> （白话那版：锁上会**拒掉自配的云端 provider**、推翻 2026-10-05「未加密空间可用云端」✗；
> 而桥那三条门禁继续代守 ✓）。⇒ 「先只定声明面」那一步（B）**已做**（见
> `docs/specs/2026-10-08-network-targets-declaration-surface.md` ✓），**A 不锁** ✓，
> 本文件 §45–46 那两行读数**照旧成立**（AI 那半边今天仍无判据 ⇒ 如实标"未立"，⛔ 不许写成"已守"）。

> ⚠️ **owner 2026-09-29 订正（按「丙」）**：`INV-KB-space-split` 分两种情况 ——
> · **已加密的个人空间** ⇒ ⛔ **永不放开**（钥匙交出去＝端到端承诺作废）
> · **明文个人空间** ⇒ ✅ **用户可显式放开**给外部 Agent／云端大模型，
>   但**必须显式同意 ＋ 如实说明去向**
> （因为「不经过我们的服务器」**≠**「数据不出本机」——
>   与 `personal-edition-requirements` 的 `INV-PER-cloud-agent-needs-consent` 同一条。）
| **INV-KB-audit-subject** | **审计能区分「人／插件／外部 Agent」三类主体** | ⚠️ **与 `INV-MCP-single-authz` 相关**，但"主体标识"是**新增**的（不在其内 ✓） | 把主体字段写死成一类 ⇒ 红 ✓ | **待立**（前置未定） | Rust/CI |
| **INV-KB-single-semantics** | **外部经桥与 App 内走同一校验点、同一过滤语义**（软删／工作空间／`content_json` 收口） | ⚠️ **归属 `INV-MCP-single-authz`**（不在本表重复 ✗） | 让桥自己写一遍过滤（少一个软删条件）⇒ 红 ✓ | 待立 | 本机 Node ＋ Rust |
| **INV-KB-derived-rebuildable** | **索引／wiki／地图都是派生物，可重建** | 删索引 ⇒ 功能不降级（只是慢）；重建后**同一查询同结果集** | 让索引成为唯一真相（删了就查不到）⇒ 红 ✓ | **部分**（"可重建"半边能跑：`check-generated-artifacts`；"删索引不降级"顺延 Phase 1 ✗） | 本机 Node |
| **INV-KB-citation-stale** | **生成物每条断言带回链；源一改即标脏；页脚写「派生，非出处」** | 三条各一机检：回链可达 ／ 源 sha 变 ⇒ 页面标脏 ／ 页脚串存在 | 改一个源文件不标脏 ⇒ 红 ✓ | **部分能**（"回链可达" ⇒ `check-wiki-freshness` ✓；"源一改即标脏" ⇒ `check-wiki-freshness` ＋ `check-generated-artifacts` ✓；**"生成物每条断言都带回链"的逐条那半仍待立** ✗） | 本机 Node（两项都可跑 ✓） |
| **INV-KB-locked-loud** | **锁定/未解锁 ⇒ 明确报错，不许返回空结果** | ⚠️ **归属 `INV-MCP-locked-fails-loud`**（不在本表重复 ✗） | 让锁定路径返回 `[]` ⇒ 红 ✓ | **能**（判据 `check-locked-loud` ✓ —— **归属仍是 MCP 那份正文** ✓ 本表不重复立 ✗） | 本机 Node（纯读 Rust 源码 ⇒ 不需要 cargo ✓） |

| **INV-KB-agent-priv-separation** | **能力面必须限于「笔记域」**：`ai:true` 的能力不许是库外／`host` 类／全局 scope（库权限 ≠ 仓库权限） | 扫注册表里 `ai:true` 的能力：id 前缀 ⊆ 笔记域 ／ `kind ∈ {read,write}` ／ `scope === current-space` ⇒ 否则红 | 加一个 `ai:true` 的 `fs.read`(host/global) ⇒ 红 ✓ | **能**（`check-agent-surface` 第 ④ 条） | 本机 Node |
| **INV-KB-external-content-marked** | **库里的「外部抓来的内容」必须带来源标记**，agent 侧对带标记内容**降权**（不当指令用） | 库条目带来源字段 ＋ agent 侧策略区分「用户写的」与「外部抓的」 | 把一条剪藏当用户笔记喂给 agent ⇒ 红 ✓ | **待立**（需产品改动：字段 ＋ 策略 ✗） | 本机 Node ＋ Rust |
| **INV-KB-model-provenance** | **agent 用不外用本地模型要能声明**；未声明 ⇒ `unknown`（⛔ 不许默认显示"本机/安全"）；且"本机模型"标记必须与**联网提醒**同屏 | ① 握手带 `model_provenance: local｜cloud｜unknown` ② 未声明显示 `unknown` ③ UI 上标记与提醒同时存在 ④ **服务端零字段**（载荷/日志无 agent 模型信息） | 不声明却显示"本机模型" ⇒ 红 ✓ | **待立**（需产品改动 ＋ 协议字段 ✗） | 本机 Node ＋ Rust |
| **INV-KB-audit-shape** | **审计的形状**：写审计**入口唯一** ＋ 条目**不含正文** ＋ **只增**（不许 UPDATE／DELETE） | 纯读 Rust 源码三条：写审计的 `.rs` 只能 1 个 ／ `PluginAuditEntry` 字段名不含 content／body／payload 等 ／ 源码里无对审计存储的改写删除 | 造两个写者 ⇒ 红 ✓ ／ 给条目加 `content_json` ⇒ 红 ✓ | **能**（`check-audit-shape` —— **不需要 cargo** ✓） | 本机 Node |

| **INV-KB-derived-provenance** | **派生内容必须自证「从哪来」**：`ExtractedSegment.kind` ＋ `loc` 必填，`SegmentKind` 有区分度 | 纯读 `src/lib/extract/types.ts`：两字段不许可选 ／ `SegmentKind` 成员 >= 3 | 把 `loc` 改成 `loc?` ⇒ 红 ✓ ／ 把联合类型砍到 1 个成员 ⇒ 红 ✓ | **能**（`check-derived-provenance` —— 不需要 Chromium／cargo ✓） | 本机 Node |

> ✅ **2026-09-28 收口：本表"能跑"的是 5 条**（其中 `INV-KB-derived-rebuildable` 只跑通"可重建"半边 ✗）
> ⇒ 它们**已按仓规收录进 [`INVARIANTS.md`](INVARIANTS.md)**（三条条件：能指到会红判据 ✓ ／ 有"看过它红"证据（账本 D2，绑脚本 sha ✓）／ 证据能原地重做（各判据都有 `--self-test` 或夹具口子 ✓））
> ⚠️ 其余 5 条仍是 `待立`（各自的判据还没写出来 ⇒ **不算通过** ✗）

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

## 6. 决定性条款（2026-09-29 按台账「沉默默认」落地；owner 已授权 ✓）

> **这一段是「拍板结果」，不是「待议」** ✓ —— 每条的来路都写在括号里的台账号上；
> 想改哪条，说一句就改 ✓（每条都写明改的代价 ✓）。**产品侧才做得了的部分另立台账行，不藏在这里** ✗

### 6.1 网络与外部助手（R34／R35／R36／R37）

- **默认只绑回环**（同一台机器足够 ✓）：外部助手必须与 ShuyoNote 同机才能用；**不开内网监听** ✓
  若要监听内网，必须同时满足三条 ✗：仅**未加密**空间可开 ／ **禁止免确认写** ／ **先能分主体审计**，且补 TLS 或逐请求签名 ✓
- **已加密的个人空间永不放开内网** ⛔（钥匙只在应用进程内存 ✓ 放开＝把端到端承诺作废 ✗）
- ⚠️ **token 边界要写明**：per-session token 防的是**网络对面** ✓，**不防同机同用户进程** ✗
  ⇒ 因此"关掉即失效 ＋ 短期轮换"比"把 token 藏深"更重要 ✓
- **agent 可用性 ⊥ 加密档位**（两根独立的轴 ✓）：加密档位决定"同步存什么、谁看得见" ✓；
  agent 可用性决定"本机哪个进程能调哪些能力" ✓ ⇒ **不要为了用助手而关掉加密** ✗

### 6.2 助手与模型（R45／R46／R47／R49）

- **助手侧永远是「可替换的 MCP 客户端」** ✓ —— ShuyoNote 只承诺**服务端与能力面**；
  因此**不把应用内助手重写成 DSH 专用客户端** ✗（押注他人运行时有版本/停更风险 ✓）
- **并存 ＋ 共用能力面**：保留应用内助手（开箱即用 ✓）＋ DSH 走 MCP 作高级/本地路径 ✓；
  两者共用：能力面 ✓ 过滤语义 ✓ 写确认 ✓ 审计 ✓ ⇒ 判据＝`INV-KB-single-semantics` ✓
- **本机模型可接**（provider 有 `baseURL`／`api` ✓）⇒ 可做到"推理也不出本机" ✓
  ⚠️ 但 **"模型在本机" ≠ "内容不出本机"** ✗（agent 仍可能联网 ✓）⇒ UI 上必须**同屏**提醒 ✓
- **模型来源要能声明**：握手带 `model_provenance: local｜cloud｜unknown` ✓；
  **未声明一律 `unknown`** ⛔（不许默认显示"本机/安全"✗）；**服务端零字段** ✓（其载荷/日志不得含 agent 模型信息 ✗）

### 6.3 审计与权限（R43／R48）

- **能力面必须限于「笔记域」** ✓（`ai:true` 的能力不许库外／`host` 类／全局 scope ✓）
  ⇒ 判据已能跑：`scripts/check-agent-surface.mjs`（注入 `fs.read` ⇒ 必红 ✓）
- **审计要能纳入外部助手的调用** ✓：入口唯一 ⇒ 审计写在**那一个校验点**上就自动覆盖 ✓；
  四条可机检判据：**同形**（外部与插件路径字段集合相同 ✓）／**可分**（人·插件·外部 Agent 三类可辨 ✓）／
  **不含正文**（审计只放元数据 ✓）／**只增**（append-only ✓）
  ⇒ 先定两个字段：主体 `source`／`actor` ✓ 与会话 `session_id` ✓

### 6.4 外部内容（R44）

- **库里「外部抓来的内容」必须带来源标记** ✓，agent 侧对带标记内容**降权**（不当指令用 ✓）
  ⇒ 判据（`INV-KB-external-content-marked`）**待产品侧字段就位** ✗（本节只落条款 ✓）

### 6.5 与既有不变式的关系

- 以上条款与 §2 的 `INV-KB-*` 一致 ✓；**已能跑的判据**见各自行，**待立的判据**仍标 `待立` ✗
- `INV-KB-space-split` 的措辞**不改** ✓：在"只绑回环"的默认下它**仍然正确** ✓
