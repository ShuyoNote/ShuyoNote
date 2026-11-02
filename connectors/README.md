# connectors/shuyonote —— WorkBuddy 连接器提交包

这是**要打包上传**给 WorkBuddy 开放平台的那个目录（不是 App 的一部分）。字段口径照
<https://open.workbuddy.cn/docs/connector> 与 <https://open.workbuddy.cn/docs/skill> 抄的，
提交前请对着文档的「提交前检查」逐条过一遍。

```
connectors/shuyonote/
├── connector-meta.json          # 市场展示：名称/描述/示例/source/版本
├── mcp.json                     # stdio：npx -p https://shuyo.cn/mcp/…tgz 拉起桥
├── icon.svg                     # 128×128，透明底，与 App 图标同形
└── skills/shuyonote-usage/
    └── SKILL.md                 # 教 AI 怎么用这些工具（发现顺序、chars_total、写入草稿）
```

## 为什么是 `npx` 而不是写路径

商店的 `mcp.json` **不许写死绝对路径**（安装路径由平台管），而 App 的 `port`/`token` 在每个用户的
应用数据目录里。桥（`tools/shuyonote-mcp`）从 2026-10-18 起**自己按平台默认目录找**，
所以这里只需要 `command: npx` + `-p <tarball 地址>` + `runtime: node`。

## 包放在哪：`https://shuyo.cn/mcp/shuyonote-mcp-<版本>.tgz`（当前路线）

不依赖 npm 账号：把 `npm pack` 出来的 tgz 传到官网服务器的 `/var/www/shuyo-site/mcp/`，
它就是一个公开的 https 地址，`npx -p <地址>` 直接装。

**当前文件**（2026-10-18）：

- 地址：`https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz`
- sha256：`c20d65c21210aa313d4bc05a9fa3c00eda0d91ac00b13b1a3dde0a1c7d670978`
- 大小：12,043 字节
- 服务器路径：`/var/www/shuyo-site/mcp/shuyonote-mcp-0.1.0.tgz`

### 更新一版（三步）

```powershell
cd tools\shuyonote-mcp
npm pack --pack-destination $env:TEMP          # 先改 package.json 的 version
scp $env:TEMP\shuyonote-mcp-<新版本>.tgz root@121.199.8.24:/var/www/shuyo-site/mcp/
ssh root@121.199.8.24 "chmod 644 /var/www/shuyo-site/mcp/shuyonote-mcp-<新版本>.tgz"
curl -sI https://shuyo.cn/mcp/shuyonote-mcp-<新版本>.tgz   # 200 + 对上 Content-Length
```

然后把 **`mcp.json` 的地址**、`connector-meta.json` 的 `version`、`package.json` 的 `version`
三处一起改。旧 tgz 可留着（地址带版本号，不会互相覆盖）。

> 为什么不发 npm：npmjs.com 的注册被 GitHub 的防机器人挡（IP 104.234.0.177 被标记）。
> 这条路不需要任何账号；将来想发 npm 也可以——`mcp.json` 换成
> `"args": ["-y", "shuyonote-mcp@<版本>"]` 即可，包本身不用改。

## 发布之后、提交之前

- [ ] `tools/shuyonote-mcp/package.json` 的 `version`、`mcp.json` 里的 tgz 地址、
      `connector-meta.json` 的 `version` —— **三处一起改**，否则 AI 拉到的还是旧包；
- [ ] `npx -y -p https://shuyo.cn/mcp/shuyonote-mcp-<版本>.tgz shuyonote-mcp` 能起来，
      且 App 开着（外部接入开关也开着）时 `pages_list` 能返回东西；
- [ ] App 没开时返回的是「通道未开：读不到端口文件」而不是崩溃（允许失败，但要说清原因）；
- [ ] `icon.svg` 在 32px 下仍能认出（两页 + 星点）；
- [ ] `connector-meta.json` 的 `source` 全局唯一（`shuyonote`），`minWorkbuddyVersion` ≥ `5.0.0`
      （用了 `mcp.json` 的 `runtime`）；
- [ ] `skills/shuyonote-usage/SKILL.md` 的 frontmatter 必填项齐（description / description_zh /
      description_en / version / author）。

## 提交（已提交，待审核）

**2026-10-18 已提交审核**：

| 项 | 值 |
|---|---|
| 连接器 ID | `oc_b625160f131e5789` |
| 市场展示名 | ShuyoNote 笔记 |
| 版本 | 0.1.0 |
| 类目 | 工具 - 办公；社交 - 笔记 |
| 上传包 | `shuyonote-connector-0.1.0.zip`（4 文件，3.9 KB） |
| tgz（运行时拉的） | `https://shuyo.cn/mcp/shuyonote-mcp-0.1.0.tgz`，sha256 `c20d65c2…70978` |
| 状态 | **审核中**（2026-10-31 后台截图确认，仍是 0.1.0 / `oc_b625160f131e5789`）——已超「预计 7 个工作日」；2026-10-31 18:10 已向 `openworkbuddy@tencent.com` 发催审邮件 |

⚠️ **审核期间冻结**：不要改 `mcp.json` 里的 tgz 地址、不要覆盖服务器上那个包 ——
审核员测到的必须与提交的一致。要发新版就等这轮出结果。

> 提交页**没有**填审核说明的地方 ⇒ 另发一封邮件到 `openworkbuddy@tencent.com`，
> 写清「本机型、需要先装 App 并开外部接入、三步测试、隐私政策链接」。邮件正文在
> 本仓提交记录那条 commit 里（或按本条上方几句自己写）。

## 提交的常规步骤（下次更新照这个走）

把 `connectors/shuyonote/` 打成 zip，在开放平台「入驻 → 资质审核 → 提交连接器」上传；
审核通过后 10～15 分钟同步到市场。

**隐私政策**：<https://shuyo.cn/privacy.html>（2026-10-18 上线，站 repo 的 `site/privacy.html`）。
平台若要求填隐私链接，就填这个。它按实际行为写清了三件事，可以直接引用：
笔记不收集；连接器四步流向；**你让 AI 读的内容会随对话交给模型服务商**（不要对外说成"数据不出本机"）。

## 两个要跟 WorkBuddy 确认的点

1. **认证口径**：本连接器是「本机 stdio + 本机回环」，token 由 App 自己校验 ⇒ `auth_mode` **省略**
   （无需认证）。提交说明里写明这一点；不要用 `auth_mode: token`（那是"用户自填凭证"的表单模式，
   我们的凭证是 App 自己写的文件，用户填不出来）。
2. **tgz 直装**：`mcp.json` 用 `npx -y -p https://shuyo.cn/mcp/shuyonote-mcp-<版本>.tgz shuyonote-mcp`，
   不从 npm registry 拉。若审核方要求"必须来自 npm"，再改发 npm（包本身不用改，只换 `args`）。

## 边界（别在说明里写成没有的）

- **提交时的口径**：只读工具 9 个、写工具 5 个；写默认**出草稿**等用户确认，`pages_update`（整页替换）**永远要确认**。
  ⚠️ 连接器包里**不列工具清单**（工具面由 App 现算，`tools/list` 拿到什么就是什么）⇒ 这段数字只是 0.1.0 提交时点；
  现行客户端已是 **34 读 + 27 写 = 61**（`capabilities/mcp-tools*.json`），市场文案不按工具数承诺。
- 不做「语义/向量搜索」：检索是关键词（多词 AND、全文索引、短词子串），中文整句会提示拆词。
- 不改用户的活动空间：跨空间读靠 `spaceId` 参数，且要用户在 App 里把档位开到「只读（全部空间）」。

## ✅ 已修（2026-10-31 核实；审核期间**不动提交包**，这里只留档）：`spaceId` 曾静默回退到当前空间

2026-10-18 发现时（档位＝可写（每次确认），活动空间＝保险柜）**实际行为**是：

| 调用 | 期望 | 当时实际 |
| :-- | :-- | :-- |
| `pages_list {limit:1}` | 当前空间 1 条 | ✅ 当前空间 1 条 |
| `pages_list {limit:1, spaceId:"<别的真实空间>"}` | `permission_denied` | ❌ 返回**当前空间**的页面 |
| `pages_list {limit:1, spaceId:"zzz-not-a-space"}` | `bad_args: 找不到空间` | ❌ 返回**当前空间**的页面 |

**2026-10-31 复核现行代码已不回落**：`plugins.rs` 的 `with_conn_for_space` ——
`spaceId` 等于活动空间 ⇒ 用活动连接；是别的空间而缺 `read:all-spaces` ⇒ `permission_denied`；
空间不存在 ⇒ `bad_args: 找不到空间 …`；**任何分支都不再静默用当前空间**。
另外 MCP 面 `pages_get` 查不到页时也已从 `null` 改成**结构化 `not_found`**（点名页 id 与实际查的空间）。

⚠️ 这些是 **App 侧**行为，不改变提交包（`connectors/shuyonote/` 一个字节没动）⇒ **不需要为此重提审核**。

