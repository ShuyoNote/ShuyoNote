# 方案：包格式"一步到位"定稿 —— `.shuyodoc` v1.1 ＋ `.shuyospace` 完整设计（2026-10-30）

状态：方案定稿（企业版已裁决，以 §9 为准；实现 M1.1 → M2a → M2b）

> 编号说明：企业版往来信件里把这些规格项称作「D 加数字」（1–8）；本文件正文统一写作 **S1–S8**，因为 D 前缀在决策门禁里是决策引用专用，裸写会被 check-decision-ids 拦。

关联：[`2026-10-29-shuyodoc-m1.md`](2026-10-29-shuyodoc-m1.md)（M1 已实现）· 企业版规范 `docs/specs/2026-10-28-package-format-spec.md`＋附录 A · 已发信箱信 `2026-10-30-windows-enterprise-package-format-ambiguities.md`

> 出发点：**不先做 M2 再发现 v1 形状要改**。所以把所有"会逼出 v2"的歧义一次定死；
> 同时**不破坏企业版已实现的 v1**（`package-format.mjs`）：所有新增都是**可选字段**，
> `format_version` 仍为 `1`，靠 `features` 声明能力。

## 0. 三条总原则

1. **交换包只装逻辑，不装实现**：不塞 SQLite/schema/Yjs 二进制（Yjs 只能作为可选 `yjs_snapshot`）。
2. **结构只有一个真相**：空间结构只在 `tree.json`；文件系统路径不表达结构；`render/` 是派生。
3. **严格读、宽容写**：读侧宁可拒收也不猜；写侧只写规范允许的字段，不为"以后可能有用"塞私有字段。

## 1. 文档包 `.shuyodoc` v1.1（向后兼容，纯新增）

### 1.1 容器与条目

```text
document.shuyodoc            # zip；store-only（method=0）；固定时间戳 1980-01-02
  manifest.json
  content.json               # Lexical JSON 根；数据库页在根上带 db 命名空间
  assets/<sha256>.<ext>      # 正文引用的附件（可选）
  checksums.json
  signature.json             # 可选
```

- **重复条目名 ⇒ 读侧拒收**（不是"后者覆盖"）。
- **未知顶层条目**：只在 `checksums.json` 里登记过才允许（否则拒收），并记 `warning: unknown-entry`。
- **嵌套 depth=0**：文档包内不允许再出现 zip 包（`*.shuyodoc`/`*.shuyospace` 条目 ⇒ 拒收）。

### 1.2 manifest（v1.1 新增字段全部可选，v1 读侧忽略）

```json
{
  "format": "shuyonote.document",
  "format_version": 1,
  "features": ["attachments","db-namespace","checksums-self"],
  "min_reader_version": "1.1",
  "source": "personal|enterprise",
  "source_app_version": "x.y.z",
  "document_id": "...",
  "title": "...",
  "created_at": "...",
  "updated_at": "...",
  "content_type": "lexical-json",
  "encrypted": false,
  "checksums_sha256": "<checksums.json 原始字节的 sha256>"
}
```

- `features`：写侧声明"本包用到了哪些扩展"；**读侧不认识某 feature ⇒ 拒收并点名**（v1 读侧没有该字段 ⇒ 按 v1 规则读，遇到新形状自然报错，行为不变）。
- `min_reader_version`：硬门槛（不满足 ⇒ 拒收并提示升级）；缺省视为 `1.0`。
- `checksums_sha256`：把 `checksums.json` 钉在 manifest 里；`checksums.json` 覆盖 manifest ⇒ 二者互锁，堵住"同时改两者使其自洽"的路径。**值按原始字节算**。
- `encrypted:true` ⇒ v1.1 仍拒收（占位，加密另行立项），但读侧错误信息要写明"该包已加密，当前版本不支持"。

### 1.3 content.json 与数据库页

- 普通页：`content.json` 是 Lexical 根对象，**保持 v1 形状不变**。
- 数据库页（`tree.kind="database"`）：`content.json` 根新增可选键：

```json
{ "root": { ...Lexical... },
  "db": { "columns": [...], "views": [...], "rows": [...] } }
```

- ⛔ 不把 `db` 拆成独立文件（保证"一个文档一个 content.json"这条读侧不变量）；
- 行数据的列引用用 **column id**，不用显示名（改名不破包）；
- 不含权限/成员/审计。

### 1.4 附件规则（文档包也带附件）

- 导出：**正文中 `attachment://<sha256>` 引用到的附件写进 `assets/`**，≤ 单文件/总大小上限。
- 导入：先校验 sha 与文件名一致；正文引用但 `assets/` 缺失 ⇒ **不算坏包**，但必须 `warning: missing-asset` 并保留引用（⛔ 不静默删引用）。
- 资产扩展名**统一小写**（Windows/macOS 大小写不敏感）。

### 1.5 checksums 与签名

- `checksums.json` 覆盖：`manifest.json`、`content.json`、`assets/**`；**排除** `checksums.json` 自身与 `signature.json`。
- 缺 checksums：格式层 `checksumsOk:false`；**导入默认拒绝**（`E_IO_CHECKSUMS`），只有 `allowUnverifiedChecksums:true` 才继续并记 warning（个人版也按此收紧，与附录 A.1 统一）。
- 签名范围：`signature.json` 若存在，签名对象固定为 **`manifest.json` 原始字节 ＋ `checksums.json` 原始字节`**；v1.1 只要求"存在则不验签、不参与 checksums"，验签留 v2。

## 2. 空间包 `.shuyospace`（M2 完整设计）

```text
project.shuyospace           # zip；store-only；固定时间戳
  manifest.json
  tree.json
  documents/<doc_id>/document.shuyodoc   # 内层：同一文档包 v1.1；内层禁止再嵌包；内层也 store-only
  files/<sha256>.<ext>                   # 附件字节（内容寻址，平铺）
  attachments.json
  id_map.json                            # 可选；导入工具写，导出不写
  checksums.json
  signature.json                         # 可选
```

### 2.1 manifest（空间包）

```json
{
  "format": "shuyonote.space",
  "format_version": 1,
  "features": ["db-namespace","checksums-self"],
  "min_reader_version": "1.1",
  "source": "personal|enterprise",
  "source_app_version": "x.y.z",
  "space": { "id": "...", "name": "...", "type": "personal|team", "created_at": "..." },
  "encrypted": false,
  "checksums_sha256": "..."
}
```

### 2.2 tree.json —— 结构唯一真相

- `format:"shuyonote.tree"`、`version:1`；`roots` 非空且与 `parent_id:null` 一致。
- `nodes`: `id → {kind, title, parent_id, document?}`；`kind ∈ page|folder|database`，未知 ⇒ 拒收并列清单。
- ⭐ **权威规则（新增，定死）**：`children` 的**顺序**与**成员关系**为权威；`parent_id` 必须与之一致。
  - 不一致 ⇒ **默认拒收**（错误列出冲突节点）；只有显式 `repairTree:true`（导入工具选项）才按 `children` 重建并记 `warning: tree-repaired`。
  - 有 `parent_id` 但 `children` 未列 ⇒ 视为"顺序缺省"：按 `title` 排序补到父末尾，记 `warning: child-order-missing`（**这与"冲突"不同**，不拒收）。
- 环 / 深度 > 1000 / 引用不存在的 id ⇒ 拒收。
- **空文件夹保留**（`children: []` 或缺省均可，导出写 `[]`）。
- `children` 条目：`{type:"node", id}` 或 `{type:"file", sha256}`；⭐ **file 条目的显示名/mime 只从 `attachments.json` 取**（tree 里不再重复，避免两处权威）。

### 2.3 attachments.json —— 附件元数据唯一权威

```json
[{ "sha256": "<64hex>", "name": "扫描件.pdf", "mime": "application/pdf", "size": 123456 }]
```

- 同一 sha 多次引用 ⇒ 只存一行（显示名取第一次出现的名字，其余在 warnings 里记 `alias-name`，⛔ 不静默改）。
- 字节在 `files/<sha256>.<ext>`；`name` 只是显示名，不作路径。
- 正文 `attachment://<sha>` 原样保留，导入后解析到新附件 id。

### 2.4 id_map.json

- **只有导入工具写**（导出不写）；内容 `{nodes:{旧:新}, documents:{旧:新}, files:{sha:新附件id}}`。
- 导入**不信任**包里的 id_map（重算），包内 id_map 只作诊断参考并记 warning。
- 重映射必须同时覆盖：`parent_id`、`children[].id`、正文内部链接、`[[标题]]` 双链（重名歧义**列报告**，不静默挑）。

### 2.5 导入语义（M2）

- 永远**新建**空间与文档 id，不覆盖、不合并；导入者成为 owner；写审计 `package.import`。
- **整包原子**：任何一步失败 ⇒ 不落任何半成品（先解到临时目录、校验全过再落库）。
- 来源保留：`origin`、原 id、导入时间。
- 数据库节点必须带 `db` 命名空间（§1.3），否则拒收并点名节点。

## 3. 尺寸、流式与 ZIP 细节

| 项 | v1.1 定稿 |
|---|---|
| 压缩 | **只允许 store**（method=0）；读侧遇压缩 ⇒ 拒收并提示"需要新版本" |
| 时间戳 | 写侧固定 `1980-01-02T00:00:00Z`（同一输入逐字节可复现） |
| ZIP64 | 允许（总大小可 >4GB）；读侧必须支持 |
| 大小上限 | 单文件 **64 MiB**、总 **256 MiB**、条目数 **10000**（默认值，客户端可配，超限 ⇒ 拒收并点名） |
| 内存 | v1.1 允许整包在内存（≤256 MiB 可控）；v2 必须支持**流式 store-only** 读写（M2 实现按流式写，避免 2× 峰值） |
| 编码 | 条目名 UTF-8，NFC 规范化；禁 `\`、绝对路径、盘符、`..`、控制字符、尾点/尾空格 |
| 条目名 | 大小写不敏感冲突（`A.png` vs `a.png`）⇒ 拒收 |

## 4. 读侧统一错误码（供两端与 CLI 对齐）

```text
E_ZIP_STRUCTURE     容器结构（重复条目/压缩/UTF-8/大小写）
E_PATH              路径穿越/非法字符/超长
E_MANIFEST          manifest 缺失/坏/版本/fmt/encrypted
E_FEATURE           不认识的 feature
E_CONTENT           content.json 缺失/坏/形状
E_CHECKSUMS         缺/不符/漏登记/多登记/自保护不符
E_TREE              tree 结构（roots/kind/环/深度/冲突）
E_ATTACHMENT        附件 sha 不符/字节缺失/元数据不一致
E_LIMIT             大小/数量超限
E_ATOMIC            导入中途失败（已回滚）
```

每条错误必须带：`code`、点名条目/节点/字段、人话消息。

## 5. 兼容矩阵

| 写侧 | 读侧 v1（企业已实现） | 读侧 v1.1 |
|---|---|---|
| v1（无新字段） | ✅ 正常 | ✅ 正常（按 v1 读） |
| v1.1（加了 features/checksums_sha256/db） | ✅ 能读就正常；遇到 `db`/新形状 ⇒ 报错（**预期**，因为 min_reader_version 会提示） | ✅ 正常 |
| v2（压缩/加密/分卷） | ❌ 拒收并提示升级 | ❌ 拒收并提示升级 |

- `format_version` 保持 **1**；"v1.1" 只是规范版本名，线上靠 `features`/`min_reader_version` 表达。
- ⛔ 不为兼容而让读侧猜：不认识就拒。

## 6. 工具与验收（"一步到位"的一半靠这个）

1. **共享 fixtures 仓库**（或本仓 `src/lib/__fixtures__/` + 一份给企业版）：正常/空文件夹/混排 children/环/深度超限/未知 kind/重复条目/坏 checksums/缺 checksums/加密/大小写冲突/超大/数据库页/文档包缺 asset —— 每个包附"期望错误码"。
2. **只读校验 CLI**：`node tools/shuyopkg-verify.mjs <file>`（两端共用 spec 派生的规则），输出 `{ok, errors[], warnings[]}`；CI 里跑 fixtures 矩阵。
3. **跨端互读读数表**（并入企业版互读验收草案 §5）：S1/S2/S3/S1/S2/S3 六方向 × fixtures。

## 7. 实施顺序（个人版）

| 段 | 内容 | 判据 |
|---|---|---|
| **M1.1**（小，先做） | 文档包：`features`/`min_reader_version`/`checksums_sha256`/资产扩展名小写/缺 checksums 默认拒/重复条目拒/未知条目校验；`db` 命名空间读写（只做透传，不做 DB 编辑） | 现有 47 条包判据 + 新增 8 条 fixtures |
| **M2a** | 空间包导出：tree/attachments/files/documents/checksums；空文件夹、混排 children、database 节点 | 往返：导出→导入→再导出，tree 等价、sha 全对 |
| **M2b** | 空间包导入：环/深度/未知 kind 拒收、id_map 重算、整包原子、审计 | 恶意包 12 类全拒且点名 |
| **M3**（另议） | 流式读写、签名验签、加密、分卷 | — |

## 8. 需要企业版确认的三条（其余按本文件执行）

1. `features`/`min_reader_version`/`checksums_sha256` 三个**可选字段**是否 v1.1 就加（读侧忽略即可，不破坏 v1）；
2. `tree.children` 权威 + 冲突默认拒收（`repairTree` 才重建）；
3. `attachments.json` 为显示名唯一权威、tree 的 file 条目只留 sha256。

> 这三条一旦确认，M1.1 与 M2 可并行开工，**不再需要 v2**。

## 9. 企业版裁决（2026-10-30 已收，**以本节为准**）

两条企业版线（`windows/enterprise` ＋ `amd/enterprise`）已合并答复，**采纳 4 处修改**，本文件前面冲突处以本节为准：

| 项 | 原提案 | **最终（企业版裁决）** |
|---|---|---|
| S3/C3 tree file 去 name/mime | 只留 `sha256` | ❌ **撤回**。tree 的 file 条目**保留 `name`（`mime` 可留）**——企业 v1 读端 `validateTree` 要求 `sha256+name`，去 name 会判死现有包；`attachments.json` 仅作**补充**权威（显示名冲突时以 tree 为准并记 warning） |
| S5 `checksums_sha256` | 存在必验 | **可选字段；v1.1 存在也不强制验**（企业 v1 读端忽略未知字段；"强制验"属行为变更，另开 v2） |
| S6 固定时间戳 | `1980-01-02` | **`1980-01-01`**（对齐服务端现状 `0x0021`）；**内层再嵌 zip/shuyodoc ⇒ v1.1 硬拒**（服务端需补扫描、客户端 TODO） |
| S8 编码/大小写/尾点/扩展名小写 | 读侧硬拒 | **写侧硬拒；读侧 v1 记 warning，v2 硬拒**（避免 v1 读端行为变更） |
| C1 `min_reader_version` | 读侧拒 `>1` | ✅ 采纳；企业当前**不拒** ⇒ 列为 gap，双方补；⛔ 不得仅靠 `format_version=1` 宣称语义变更 |

其余维持本文件：S1（`db` 命名空间，服务端 `content` 是 opaque jsonb、不冲突）、S2（children 权威、冲突拒收、缺省补序不判冲突；`documents-flat` 派生包不得被误判）、S4（文档包带附件；⚠️ **企业 `import-document` 目前只 warning 不入库，排 P0b**）、S7（签名"存在不验"）。

### 9.1 企业版实测（可核读数）

```text
synthetic fixture：6176 B，sha256 f67d70d024ff9d7a4e59935e246132424f9309639a1e03740487d8339f8feafe
服务端 inspect：checksums_ok=true / entries=8 / errors=[]；nodes=4 roots=2 kinds{folder:2,page:1,database:1} empty_folder_children=1
服务端 import-space（真 PG）：nodes=4 / documents=2 / attachments=1 / file_refs=1 / tree_store=space_changes
warnings=[id-map-ignored]（预期）；parent/children/附件名/大小/mime/sha 均还原 ✅
⇒ 客户端合成包 → 服务端 inspect/import 双向 PASS（v1 形状）
```


> **M2a 修正（2026-10-30）**：**写侧不写 `checksums_sha256`；`checksums.json` 覆盖 `manifest.json`（附录 A.1）；该字段仅读侧容忍。** 之前为避哈希环把 manifest 排除在外会被企业版判 `E_CHECKSUMS`，已撤回。

### 9.2 仍然待办（双方）

1. **C1**：`min_reader_version > 支持版本` 必须拒收（企业需补，个人版 M1.1 一并实现）；
2. **S6**：内层嵌套扫描（服务端 TODO、个人版 M2 前实现）；
3. **S4**：企业 `import-document` 的 assets 入库（P0b）；
4. **S8**：写侧硬拒 vs 读侧 warning 的分层实现（个人版 M1.1 做写侧；读侧 warning 记录）；
5. 互读验收草案 `docs/specs/2026-10-30-package-interop-acceptance.md`（企业仓分支）由 `windows/enterprise + contract-conformance` 审，走附录 C 合并。

## M2a 实现证据（2026-10-30）

- 导出实现：`src/lib/docSpacePackWriter.ts::buildSpacePackage`（纯格式层）——manifest（format/`features`/`min_reader_version`/`space`/`encrypted`/`checksums_sha256`）、`tree.json`（children 顺序/成员权威、空文件夹 `[]`、§9 file 条目保留 `name/mime`）、`documents/<id>/document.shuyodoc`（内层复用文档包写侧、禁止再嵌套）、`files/<sha256>.<lower-ext>`、`attachments.json`（sha 去重、显示名以 tree 为准并记 `attachment-name-conflict`）、`checksums.json`（覆盖 tree/documents/files/attachments；manifest 用 `checksums_sha256` 反钉）；**不写 `id_map.json`**。固定 `1980-01-01`、store-only ⇒ 同输入逐字节可复现。
- 判据：`src/lib/docSpacePackWriter.test.ts`（9 条：结构/树权威/空文件夹/混排/db 命名空间/内层可读且不再嵌包/可复现/checksums/名字冲突/children-parent 冲突）；包判据合计 58 条全绿。

## M2b 读侧骨架证据（2026-10-30）

- `src/lib/docSpacePackOpen.ts::openSpacePackage`：整包校验（checksums 必须覆盖 manifest；缺 ⇒ `E_IO_CHECKSUMS`，可显式 `allowUnverifiedChecksums`）＋ manifest（format/version/space/min_reader_version 高拒/encrypted 拒）＋ tree（roots 非空、kind 白名单、children 权威、parent_id 冲突拒、环/深度 ≤1000、空文件夹保留、混排 children、file 条目 name/mime §9）＋ attachments（sha/size/字节缺失）＋ 内层 `documents/<id>/document.shuyodoc` 复用文档包读侧且**禁再嵌包**；`id_map.json` **不信任**（`id-map-ignored` warning）。
- 判据：`src/lib/docSpacePackOpen.test.ts`（10 条：往返/未知 kind/冲突/深度/坏 checksums/缺 checksums/嵌套包/附件缺失/id_map 不信任/manifest 高版本与加密）；包判据合计 **68 条**全绿。
- ⏳ 未做（下一批 M2b 落库）：导入永远新建 id、id_map 重算、children+parent 一起重映射、整包原子落库、审计 `package.import`。

## M2c 导入落库证据（2026-10-30）

- Rust 单命令 `space_package_import`（`src-tauri/src/space_import.rs`）：新建空间 → 事务内按拓扑序 `create_node_in` 建节点（folder/page/database，父子重映射）→ 内层 content 落库 → 附件按 sha 落盘/去重并插 `attachments` 行；失败 ⇒ 回滚事务并**删除 meta 行/空间库/附件目录**（原子）。判据 `space_import::tests`：`space_import_creates_new_space_with_remapped_ids_and_counts`、`space_import_is_atomic_on_failure`（2 passed）。
- 前端胶水 `src/lib/docSpacePackImport.ts`：`unzipDocument` → `openSpacePackage` → `api.importSpacePackage`，warnings 透传；判据 `docSpacePackImport.test.ts`（1 passed）。
- ⏳ 未做：id_map 重算与正文/双链重写、持久审计、UI 选文件入口。
