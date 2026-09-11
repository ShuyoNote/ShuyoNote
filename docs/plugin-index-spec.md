# `plugin-index.json` 规范（一页纸）

> 这份文件就是**公开规范**：照着写一份 JSON、放到任何静态可达的地方，别人就能在应用里
> 「插件管理 → 从索引安装（给 URL）」填你的地址、看到条目、装上插件。
> 应用**不内置任何官方索引**——你订阅谁由你决定（自托 = 自担）。
>
> 相关：[插件作者文档](plugin-api.md)（怎么写插件）· [插件配方](plugin-recipes.md)（打包 / 签名 / 发布流程）·
> [插件开发者政策](plugin-policy.md)（发布前必读）· [分发策略](plans/2026-09-10-plugin-distribution-strategy.md)（为什么这么设计）

## 1. 最小可用索引

```json
{
  "indexVersion": 1,
  "owner": { "id": "example", "name": "示例索引", "url": "https://example.com/plugins/" },
  "generatedAt": "2026-09-11T12:00:00Z",
  "plugins": [
    {
      "id": "weekly-review",
      "name": "周回顾",
      "version": "1.0.0",
      "apiVersion": "1.0.0",
      "minAppVersion": "1.87.0",
      "runtime": "logic",
      "description": "把最近几天动过的页面汇成一篇草稿。",
      "publisher": "your-name",
      "license": "MIT",
      "permissions": [{ "id": "read:pages", "reason": "读取页面标题与更新时间（不含正文）" }],
      "downloadUrl": "https://example.com/plugins/weekly-review-1.0.0.zip",
      "size": 3891,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

可照抄的完整样例（带注释性说明）在 [`plugin-index.example.json`](plugin-index.example.json)；
它被一条 Rust 测试盯着——规范改了而样例没同步，门禁就会红。

## 2. 字段

**顶层**

| 字段 | 必填 | 说明 |
|---|---|---|
| `indexVersion` | ✅ | 必须是 `1`。将来不兼容的改动会升这个数字，旧应用会明确拒绝而不是猜 |
| `owner` | 建议 | `{ id, name, url }`。**界面会把 `name` + 域名显示成"来源"**，用户要看出自己订阅了谁 |
| `generatedAt` | 建议 | ISO 8601 时间串 |
| `revokedKeys` | 可选 | 被撤回的发布者密钥，见 §5 |
| `plugins` | ✅ | 至少一条；空索引会被拒（"索引里一个插件都没有"） |

**每个插件**

| 字段 | 必填 | 说明与限制 |
|---|---|---|
| `id` | ✅ | **比本地安装更紧**：`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`（小写字母/数字/短横线，2–40 位，不以短横线开头或结尾）。与包内 `manifest.json` 的 `id` 必须一致；**不可改名** |
| `version` | ✅ | 必须三段齐全：`1.2.0`（可带 `-pre`/`+build` 尾巴）。与 manifest 内的版本一致 |
| `apiVersion` | ✅ | 语义化版本；**未知 major 直接拒载**（不猜兼容） |
| `minAppVersion` | ✅ | 三段版本。低于它的应用会显示"需要应用 X+"且**不给装** |
| `runtime` | ✅ | `logic` / `declarative`。`ui` 暂不受理（本版本没有 UI 插件宿主，拒绝比"装上了什么都不发生"诚实） |
| `downloadUrl` | ✅ | 插件包（zip）地址；**必须 https**（唯一例外：本机回环地址，供自托调试） |
| `size` | ✅ | 包体积（字节）。用于安装前的体积预检；与实际不符会被拒 |
| `sha256` | ✅ | 包的 sha256，**64 位十六进制**。安装前必须对得上，否则拒绝安装 |
| `permissions[].id` / `.reason` | ✅ | 权限 id（见 `capabilities/capabilities.json`）+ **给用户看的理由**，理由为空会被拒 |
| `license` | ✅ | 合规底线，至少要声明 |
| `name` / `description` / `publisher` | 建议 | 界面展示用；`publisher` 是"谁发布的"这一栏 |
| `homepage` / `discussionUrl` / `changelogUrl` | 可选 | 评价走社区帖子（`discussionUrl`），应用内不做评分/埋点 |
| `signature` / `publisherKey` | 可选 | 发布者签名，见 §4。**必须成对出现** |
| `revokedAt` / `revokedReason` | 可选 | 撤回这一条，见 §5 |

## 3. 应用会强制什么（在规范之外）

| 规则 | 为什么 |
|---|---|
| 索引与插件包只走 **https**（回环地址例外） | 明文下"完整性"只剩一个裸奔的哈希，中间人能同时改包与索引里的哈希 |
| 体积上限：索引 4 MiB、签名 64 KiB、包 64 MiB（含解压后总量），包内文件 ≤ 512 | 挡 zip bomb 与"顺手塞个安装器进来"；上限在**下载途中**也守 |
| 解包只认普通文件与目录；反斜杠 / 绝对路径 / `..` / 符号链接一律拒 | zip-slip 是"任意写"的经典入口 |
| 顺序固定：下载 → 体积 → `sha256` → 解包到临时目录 → `manifest` 校验 → 才拷进插件目录 | 任何一步失败都不留半个插件目录（半装目录会占住那个 id） |
| 包内**多一层同名目录**会自动下钻 | `zip -r pkg.zip my-plugin/` 的常见产物；只在"恰好一层且里面有 manifest.json"时下钻，其余不猜 |

## 4. 签名（两件不同的事）

**索引签名**（"这份索引没被换过"）：把 `plugin-index.json` 用 minisign 签一份
`plugin-index.json.minisig` 放在同一目录。用户在面板里填**公钥**（裸 base64 或 `minisign.pub`
内容都认）；填了公钥就**必须**能取到签名并校验通过——取不到也算失败，否则"签名服务器挂了"
就成了绕过校验的开关。没填公钥时界面会明说"没有校验"，不会假装。

**发布者签名**（"这个包是谁签的"）：给每个包签一份 `signature`，并在条目里给出 `publisherKey`。
应用在**第一次装成功后把这把公钥固定下来**（TOFU），此后同一个插件**换了公钥就拒绝安装**，
并把新旧指纹一起摆给用户确认——**索引被换掉也换不掉用户已经固定过的那把 key**。
指纹是公钥盒 42 字节的 sha256 前 16 位（`xxxx-xxxx-xxxx-xxxx`），由应用计算并显示；
换密钥时**必须在发布说明里公示新指纹**，用户才有机会核对。

```bash
minisign -Sm plugin-index.json                  # 索引签名 → plugin-index.json.minisig
minisign -Sm weekly-review-1.0.0.zip            # 发布者签名 → 填进 signature
minisign -G -p mykey.pub                        # 还没密钥就先建一对
```

## 5. 撤回（两级，都**离线生效**）

| 撤回什么 | 怎么写 | 应用会做什么 |
|---|---|---|
| **某个版本** | 条目里加 `revokedAt`（可附 `revokedReason`） | 刷新索引后不再展示、不给装；**已装用户**的那一版：运行与安装都被拦下，并显示原因 |
| **一把发布者密钥** | 顶层 `revokedKeys: [{ "key": "<公钥>", "reason": "…", "revokedAt": "…" }]` | 用这把 key 签的条目不可安装；已装且固定的就是这把 key 的插件：运行被拦下 |

撤回会被应用**记住**：不再依赖"用户下次还来拉索引"。用户仍可显式选择「仍然使用」
（索引拥有者不是用户的上司，这一层的作用是让他知道并**明确表态**）——
所以 `reason` 请写清楚，那是他做判断的依据。撤回的是**那个版本 / 那把密钥**：
索引后来发的修好的新版本不受影响。

## 6. 发布流程（三步 + 可选签名）

```bash
zip -r weekly-review-1.0.0.zip weekly-review          # 1) 打包（包内根目录就是插件目录）
shasum -a 256 weekly-review-1.0.0.zip && wc -c < weekly-review-1.0.0.zip   # 2) sha256 + size
# 3) 写进索引（downloadUrl / size / sha256 / permissions + reason …）
```

本机先把这条路走通（不必先有服务器）：

```bash
node scripts/plugin-index-demo.mjs weekly-review 8787            # 打包 + 起一个只监听 127.0.0.1 的索引
# 把打印出来的 http://127.0.0.1:8787/plugin-index.json 填进「从索引安装（给 URL）」
node scripts/plugin-index-demo.mjs weekly-review 8788 --version 9.9.9   # 再演一次"升级"
```

**也可以直接订阅一份线上索引**（数友社区托管的第一方插件索引，真实可用）：

```
索引：https://community.shuyo.cn/plugins/plugin-index.json
签名：https://community.shuyo.cn/plugins/plugin-index.json.minisig
公钥：untrusted comment: minisign public key 305A2DFBAC0773C1
      RWTBcwes+y1aMIEdFdER5PCz4QsdYqVlBSMr6++SnWdoRUVI3DLcduK4
```

把索引地址与公钥一起填进「从索引安装（给 URL）」→ 拉取（应当显示"校验通过"）→ 订阅 → 安装。
里面的 18 个插件就是仓库 `examples/plugins/` 里的那些，每个都有发布者签名，索引本身也有签名。

> 托管方在发布前应当自己先验一遍（这三步都用应用**真正的**代码，不是眼看）：
> ```bash
> curl -sO https://community.shuyo.cn/plugins/plugin-index.json{,.minisig}
> SHUYONOTE_INDEX_FIXTURE=plugin-index.json \
> SHUYONOTE_INDEX_SIG=plugin-index.json.minisig \
> SHUYONOTE_INDEX_PUBKEY=<公钥文件> SHUYONOTE_INDEX_APP_VERSION=<当前版本> \
>   cargo test --lib external_index -- --ignored --nocapture
> ```
**托管方交出去之前，把"线上那一份"也验一遍**（HTTP 层，一条命令）：

```bash
pnpm check:plugin-hosting --url https://community.shuyo.cn/plugins/plugin-index.json
#   索引/签名：200、且缓存头不会把它藏起来（no-store）
#   每个包：线上字节与索引里的 size/sha256 **逐条一致**、可长缓存（immutable）、不是网页
```

> 顺带提醒两条**签名格式**上的坑（都踩过）：公钥盒的算法字节是 `Ed`(0x45 0x64)，
> 而签名盒是 `ED`(0x45 0x44)——写错时应用**两种都收**、测试全绿，只有真 minisign 会拒绝；
> 索引与 `.minisig` 的缓存头必须 `no-store`（索引被长缓存 = 新插件永远看不到），
> 插件包则 `immutable`（名字带版本号，内容不变）。

## 7. 多源与订阅

应用支持**同时订阅多个索引**（自托一个、社区一个、企业内网一个）：面板里可增删、逐条切换、
一次检查全部（逐条记上次结果，一条失败不影响其它），并显示每条里有几个插件可更新。
索引内容**永远现场拉**——用一份过期的清单做判断（"可更新"、"已撤回"）比不判断更糟。

## 8. 一句话边界

**应用不审核索引里的一切。** 装之前它会摆出：来源域名、权限与理由、签名状态与发布者指纹、
静态扫描得到的事实、以及装完之后内容有没有被改过。**能装不等于可信**——判断留给用户。
