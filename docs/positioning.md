# ShuyoNote 产品定位

> 综合两份竞品对比（[本地 PKM](compare-obsidian-siyuan-shuyonote.md)、[云端 Notion 类](compare-flowus-wolai-notion-shuyonote.md)）收敛出的定位陈述、目标用户与差异化。

## 1. 定位陈述

**ShuyoNote 是一款「本地优先、Notion 式块编辑 + 关系型知识工作台」的桌面 / 浏览器应用**——在本地 SQLite 上提供类 Notion 的块编辑器、属性数据库、块级引用/嵌入与关系图，兼顾「结构化编辑」与「数据主权/离线」。桌面为主（Tauri + Rust），同一前端经平台 driver 抽象也能在**纯浏览器**运行（`pnpm dev:web`）。

一句话：**「本地优先的 Notion 替代，叠加思源的块级引用与 Obsidian 的关系图。」**

## 2. 目标用户

- 重视**数据主权与隐私**、不愿把笔记交给云端的个人 / 极客。
- 需要 **Notion 式块编辑与数据库**，但希望**离线可用、无订阅、数据自持**。
- 接受**桌面单机 + 自建同步**、暂不需要多人实时协作的用户。

## 3. 竞品全景

ShuyoNote 处于两条竞品轴线的交汇处：

| 轴线 | 代表产品 | 特征 | ShuyoNote 的取舍 |
|------|----------|------|------------------|
| **本地 PKM** | Obsidian、思源笔记 | 数据本地、块级/图/插件生态 | 借鉴其块级引用、关系图、属性数据库 |
| **云端 Notion 类** | Notion、FlowUs、Wolai | 云端协作、AI、全平台 | 借鉴其块编辑与数据库视图，但转向本地 |

```
                  块编辑 + 数据库
                        ▲
        Notion / FlowUs / Wolai（云端）
                        │
      ──────────────────┼──────────────────  ShuyoNote（本地优先）
                        │
        Obsidian / 思源（本地 PKM）
                        ▼
                  Markdown / 文本
```

## 4. 差异化矩阵

| 维度 | ShuyoNote 的相对位置 |
|------|----------------------|
| 数据存储 | 本地 SQLite（优于云端三者的主权/离线，弱于 Obsidian 的纯文本可移植） |
| 编辑体验 | 块编辑器（与 Notion 品类一致，优于 Obsidian 的文本范式） |
| 块级能力 | 块引用/嵌入/反链（借鉴思源，与思源同级） |
| 关系图 | 力导向 + 局部/过滤/着色（借鉴 Obsidian，优于思源） |
| 数据库 | 属性 + 三视图（借鉴思源 + Notion 品类，已对齐） |
| 协作 / AI | 短板（本地优先的代价；AI 倾向本地接入，见[设计哲学](design-philosophy.md) §10） |
| 移动端 | 短板（环境受限未做；浏览器 Web 平台可用，见 [M16](roadmap.md)） |

## 5. 借鉴矩阵（已落地）

| 能力 | 借鉴自 | 落地位置 |
|------|--------|----------|
| 块编辑器、属性 + 数据库视图 | Notion 品类 | Lexical + `database.rs` + DatabaseView |
| 块引用 `((id))` / 嵌入 `{{id}}` / 块级反链 | 思源 | `BlockRefNode` / `BlockEmbedNode` + `blocks.rs` |
| 关系图（局部/过滤/着色） | Obsidian | `GraphView` |
| 属性面板（Properties 式） | Obsidian / 思源 | `PropertiesPanel` |
| 标签维度、`[[双链]]` | Obsidian / 思源 | `tags` / `backlinks` |

## 6. 自研差异化

- **Tauri + SQLite + FTS5 中文检索**：轻量、离线、无 Go 后端 / 无 Docker 依赖。
- **自建 sync-server**：outbox 变更日志 + LWW + 附件内容寻址，无第三方云依赖。
- **开源（MIT）+ 免费**：数据完全自持。

## 7. 价值主张（一句话对用户）

> 如果你想要 Notion 的块编辑与数据库、思源的块级引用、Obsidian 的关系图，但**不愿把数据交给云端、且希望离线免费开源**——ShuyoNote 就是为此而做。

## 8. 下一阶段

详见 [roadmap.md](roadmap.md)：优先补 **Markdown 无损往返（可移植性）**、**端到端加密（数据安全）**、**主题/插件（扩展性）**。
