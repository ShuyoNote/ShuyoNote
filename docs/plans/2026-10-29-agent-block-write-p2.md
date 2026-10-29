# 方案：外部 Agent 的**块级写面**（P2）—— 寻址、版本校验、审计

状态：方案确认（未开始实现）—— 前置：P1（md 读投影 + 块锚点）尚未落地；owner 2026-10-29 要求「Agent 要读写」。

关联：本仓 MCP 写入口现状（`pages_create` / `blocks_append` / `pages_importMarkdown` / `pages_update`，2026-10-29 实测 13 个工具）与 `.shuyodoc` M1 格式层（`src/lib/docPackage*.ts`）。

## 问题

现有 MCP 写工具**粒度太粗**：整页导入 / 整页替换 / 尾部追加。外部 Agent 要"改第三段"，只能整页重写 ⇒ 并发时会覆盖别人的改动、且无法把结论锚定到具体段落。

## 目标

1. Agent 能**按块**读、按块改（定位稳定、失败可解释）；
2. 并发写**不会静默覆盖**（版本不匹配就拒绝并给 diff）；
3. 每次写**留痕**（审计 + 历史版本），企业策略可关/可审。

## 不做（明确排除）

- ⛔ 不做磁盘 md 镜像（那是 P4，双真源风险最高）；
- ⛔ 不做"盲写整篇覆盖"（P3 的整页 md 写必须走锚点对齐 + 拒绝歧义）；
- ⛔ 不改评论/历史版本模型；⛔ 不动加密空间（锁着 ⇒ 拒绝，不猜口令）。

## 读面（P1，P2 的前置）

`pages_get` 返回值增加：

```json
{
  "id": "…", "title": "…",
  "rev": "<updated_at 毫秒>:<content_json sha256 前 8 位>",
  "markdown": "## 小节\n\n正文…\n\n<!-- b:ab12cd34 -->\n\n下一段…\n\n<!-- b:ef56ab78 -->"
}
```

- 每个**顶级块**后一行锚点注释 `<!-- b:<blockId> -->`；锚点数量必须等于顶级块数（判据）；
- `rev` 是**乐观并发令牌**，不是时间戳语义；Agent 写回时原样带回。

## 写面（P2 新增工具）

| 工具 | 参数 | 语义 |
|---|---|---|
| `blocks_patch` | `blockId`, `markdown`（或 `text`）, `expectedRev`, `dryRun?` | 整块替换；块 id 保持不变 |
| `blocks_insert` | `pageId` 或 `afterBlockId`, `markdown`, `expectedRev`, `dryRun?` | 在某块之后插入（缺省页首） |
| `blocks_delete` | `blockId`, `expectedRev`, `dryRun?` | 删除单块（不留空占位） |
| `pages_write_markdown`（P3） | `pageId`, `markdown`, `expectedRev`, `dryRun?` | 整篇 md 写：按锚点对齐；对不上/歧义 ⇒ **拒绝并点名块** |

统一返回：

```json
{ "applied": true, "rev": "<新 rev>", "changed": ["ab12cd34"], "auditId": "…" }
```

失败码（都必须**说人话**，不许静默降级）：

- `rev_conflict` —— 带 `currentRev` 与 `currentMarkdown`（Agent 可 diff 后重试）；
- `not_found` / `permission_denied` / `invalid_markdown` / `too_large`；
- `ambiguous_target`（P3 专用）—— 点名"哪一块对不上，以及候选块"。

## 写路径硬约束

1. **必须走应用自己的写入口**（与 UI 同一条）；⛔ 不直连 SQLite、⛔ 不绕过派生化写入（`attachment_text` / `chunks` 只允许 TS 抽取管线写）；
2. **写前快照**：进历史版本；**写后**审计一条（`source = external:<session>`、工具名、块 id 列表、时间）；
3. **权限**：新增能力 `blocks.write`，**默认关**；个人版首次写弹一次确认，企业版按策略；读写删可分档授权；
4. **幂等**：同一 `expectedRev` 的第二次写必须 `rev_conflict`（不重放副作用）。

## 判据（实现即验收）

1. 并发冲突**必拒**：读到 rev=R → A 写成功 → B 用 rev=R 写 ⇒ `rev_conflict`，且返回的 `currentRev`=R+1；
2. `blocks_patch` 后：目标块 id 不变、其余块 id 不变、`blocks→md` 与预期 AST 等价；
3. `blocks_insert`/`blocks_delete` 后：锚点数 = 块数；无空块残留；
4. `dryRun=true` ⇒ 不写库（rev 不变、审计不加），且输出与真实写一致；
5. 权限关 ⇒ `permission_denied`（⛔ 不许"退化成只读成功"）；
6. 每次成功写 ⇒ 审计恰 1 条、历史版本恰 1 条；
7. 锁着的加密空间 ⇒ 明确拒绝（⛔ 不猜、⛔ 不落半条）。

## 阶段与顺序

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| P1 | `pages_get` 加 `rev` + 锚点 md | 上述 2、3 条（读面） |
| P2 | `blocks_patch/insert/delete` | 1、2、3、4、5、6、7 全绿 |
| P3 | `pages_write_markdown`（锚点对齐 + `ambiguous_target`） | 歧义包必拒；dryRun 一致 |
| P4 | 磁盘 md 镜像 | **不在本方案**（单独立项） |

## 已识别的风险

- **块 id 稳定性**：撤销/CRDT 合并后块 id 是否保持？若不保持，锚点会指向已消失的块 ⇒ 必须先实测（undo、同步合并两条路径）；
- **锚点污染**：`pages_get` 默认带 `<!-- b:… -->` 会占 token；是否需要 `includeAnchors` 开关（默认 true 但要能关）；
- **rev 形态**：`updated_at+hash` 无需迁移但有并发边界（同毫秒两次写）；独立整数 rev 需迁移但更干净 —— **待拍**；
- **审计量**：批量 `batch` 会放大审计条数（按次合并成一条还是每块一条）—— 待定。

## 待拍

1. `rev` 用 `updated_at + content_json sha256`（零迁移）还是新加整数字段（要迁移）？
2. `pages_get` 默认带不带锚点（影响所有 Agent 的 token 成本）？
3. `blocks.write` 授权方式：个人版"首次写弹一次"是否可接受？
