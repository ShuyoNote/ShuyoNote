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

## 提交

把 `connectors/shuyonote/` 打成 zip，在开放平台「入驻 → 资质审核 → 提交连接器」上传；
审核通过后 10～15 分钟同步到市场。

## 两个要跟 WorkBuddy 确认的点

1. **认证口径**：本连接器是「本机 stdio + 本机回环」，token 由 App 自己校验 ⇒ `auth_mode` **省略**
   （无需认证）。提交说明里写明这一点；不要用 `auth_mode: token`（那是"用户自填凭证"的表单模式，
   我们的凭证是 App 自己写的文件，用户填不出来）。
2. **npmmirror 同步**：`mcp.json` 先试 `registry.npmmirror.com` 再回落 `registry.npmjs.org`。
   如果审核方对"双 registry"有意见，删掉 `npmRegistries` 只留默认也可以（国内拉包会慢一点）。

## 边界（别在说明里写成没有的）

- 只读工具 9 个、写工具 5 个；写默认**出草稿**等用户确认，`pages_update`（整页替换）**永远要确认**。
- 不做「语义/向量搜索」：检索是关键词（多词 AND、全文索引、短词子串），中文整句会提示拆词。
- 不改用户的活动空间：跨空间读靠 `spaceId` 参数，且要用户在 App 里把档位开到「只读（全部空间）」。
