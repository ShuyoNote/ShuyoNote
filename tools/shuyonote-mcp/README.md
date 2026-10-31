# shuyonote-mcp —— 一个「哑」桥：把 MCP 客户端接到 ShuyoNote

这个目录里只有一件事：让外部的 AI 助手（Claude Code、DSH／WorkBuddy 这类支持 **MCP** 的客户端）
能访问你在 ShuyoNote 里的笔记 —— **读**是默认能力；**写**要你先授权，且按下面的确认口径走
（覆盖式写永远要你点确认）。

## 形状（先看这张图，后面所有行为都由它决定）

```
   AI 客户端 ──stdio(行分隔 JSON-RPC)──▶  桥 index.mjs  ──HTTP POST /call──▶  ShuyoNote（App 自己）
                （MCP 协议）                （只转发，不判权限）      （127.0.0.1，要 Bearer 令牌）
```

三条口径（都是**刻意**的，不是实现细节）：

1. **App 是服务端，桥是客户端** ✓ —— 权限、落库、审计**全在 App 那侧一处**；桥里**不判权限、不碰库、不写审计** ✗
   （有两条门禁专门钉这个：`scripts/check-mcp-bridge-dumb.mjs` ✓、`scripts/check-mcp-bridge-stdout.mjs` ✓）。
2. **只绑本机** ✓ —— App 只监听 `127.0.0.1`（同一个 Wi-Fi 下的设备也连不上 ✓）。
3. **默认关** ✓ —— 不打开开关，App 根本不起监听（不是"开着只是没显示" ✗）。

## 怎么打开

**桌面版 App → 设置 → 「外部 AI 接入」** ✓（打开后有状态、有令牌、还有一段**可以复制的配置** ✓）。

五个档位（换档会**换一枚令牌**，旧的立刻作废 ✓）：

| 档位 | 能干什么 |
| :-- | :-- |
| 不接 | 通道关掉，之前那枚令牌同时失效 |
| 只读 | 读**当前空间**；写请求被明确拒 |
| **只读（全部空间）** | 读**任意空间**（`pages_search` / `pages_list` 带 `spaceId`）——仍然**不能写**，也**不会改变你正在看的空间** |
| 可写（每次确认） | 外部改动先变成待确认的草稿 |
| 可写（免确认） | 直接落库（每次写仍留一行审计）；整页替换仍要确认 |

* 打开时自动生成一枚**会话令牌**，写在 `<应用数据>\mcp\token`（第 1 行令牌、第 2 行逗号分隔的授权 ✓）；
* 实际端口写在 `<应用数据>\mcp\port` ✓；
* **关掉 ⇒ 每个请求立刻被拒** ✓，**重新打开会换一枚新令牌**（旧令牌作废 ✓）。

桥本身有两个来源，面板会**自动填好**它找到的那一个：
* **安装包自带**：`<安装目录>/mcp/index.mjs`，且 `paths.mjs` **必须跟着一起发**（桥 `import` 它；三份平台包配置都随包发这两个文件 ✓ —— 2026-10-19：1.92.20 只发了 `index.mjs`，导致装完必 `ERR_MODULE_NOT_FOUND`，`scripts/check-mcp-bundle-resources.mjs` 现在盯着这件事）；
* **源码仓库**：`<仓库根>/tools/shuyonote-mcp/index.mjs`（`pnpm tauri dev` 时 ✓）。

⚠️ 两种都要求本机有 **Node.js**（桥是一个零依赖的 `node:fs` 脚本，不要求 `npm install`，
但要能跑 `node`）。

开发／判据场景也可以用环境变量（与面板是**同一条**路 ✓，两者任一为真即为开）：

```powershell
$env:SHUYONOTE_MCP_SWITCH   = "on"
$env:SHUYONOTE_MCP_TOKEN_FILE = "C:\path\to\token"
$env:SHUYONOTE_MCP_PORT_FILE  = "C:\path\to\port"
```

## 接到你的 AI 客户端

把下面这段放进客户端的 MCP 配置（**路径换成你机器上的**；两个环境变量就是上面那两个文件 ✓）：

```json
{
  "mcpServers": {
    "shuyonote": {
      "command": "node",
      "args": ["C:\\path\\to\\ShuyoNote\\tools\\shuyonote-mcp\\index.mjs"],
      "env": {
        "SHUYONOTE_MCP_TOKEN_FILE": "C:\\Users\\<你>\\AppData\\Roaming\\cn.shuyo.shuyonote\\mcp\\token",
        "SHUYONOTE_MCP_PORT_FILE": "C:\\Users\\<你>\\AppData\\Roaming\\cn.shuyo.shuyonote\\mcp\\port"
      }
    }
  }
}
```

（App 的「外部 AI 接入」那一节里同样有一段现成的、路径已填好的配置可以直接复制 ✓。）

## 不填路径也能连（2026-10-18 起）

桥会**自己去找** App 写的两个文件，所以配置里可以只写 `command`（连接器商店里那份 `mcp.json`
**不允许**写死用户机器上的绝对路径，靠的就是这一条）：

| 系统 | 默认位置 |
| :-- | :-- |
| Windows | `%APPDATA%\cn.shuyo.shuyonote\mcp\{port,token}` |
| macOS | `~/Library/Application Support/cn.shuyo.shuyonote/mcp/{port,token}` |
| Linux | `$XDG_DATA_HOME/cn.shuyo.shuyonote/mcp/{port,token}`（未设 ⇒ `~/.local/share/…`） |

优先级：`SHUYONOTE_MCP_PORT_FILE` / `SHUYONOTE_MCP_TOKEN_FILE`（单项）> `SHUYONOTE_MCP_HOME`（整个目录）
> 平台默认。⛔ 三个都不配、App 也没开 ⇒ 报「通道未开：读不到端口文件（…）」—— **不猜、不假装连上** ✓。

## 想放进连接器商店（WorkBuddy 那类）

这份桥已经按"商店连接器"的形状准备好了：

- ✓ **不用用户填路径**：见上一节（默认目录）；
- ✓ **能打成 tgz 直接从 https 装**：`tools/shuyonote-mcp/package.json` 已就位（`bin: shuyonote-mcp`，
  零依赖，Node ≥ 20）⇒ 商店那份 `mcp.json` 写
  `command: "npx"`、`args: ["-y", "-p", "https://shuyo.cn/mcp/shuyonote-mcp-<版本>.tgz", "shuyonote-mcp"]`、
  `runtime: {type:"node"}` 即可（**不需要 npm 账号**）；
- ✓ **连接器目录**：已在仓内 `connectors/shuyonote/`（meta / mcp.json / icon.svg / SKILL.md），
  发布与提交步骤见 `connectors/README.md`；
- ▢ **认证口径**：本桥是**本机 stdio + 本机回环**，token 由 App 自己校验 ⇒ 商店侧应声明**无需认证**
  （`auth_mode` 省略），不是 OAuth 也不是"用户自填 Token"表单。


## 它能看到什么（34 个只读 ＋ 27 个写 = 61，写按档位出现）

| 工具 | 干什么 |
| :-- | :-- |
| `pages_get` | 读一页的标题与正文纯文本（**必须看 `chars_total`** 才知道有没有读全 ✓） |
| `pages_search` | 按关键词搜页面（多个词用空格分隔 = 全部出现；空结果会带 `scope`：哪个空间、多少页）。可带 `spaceId` 读别的空间（需「只读（全部空间）」档） |
| `pages_list` | 按最近更新倒序列页面（**搜索之外的发现通路**：搜不到时先看这里）。同样认 `spaceId` |
| `blocks_list` | 列这页的块（含数据库块的视图） |
| `backlinks_list` | 谁引用了这页 |
| `files_list` | 列附件 |
| `files_search` | 在附件抽取出的文本里搜 |
| `files_read` | 读附件的抽取文本（支持分页 ✓） |
| `spaces_list` | 列空间与当前活动空间 |

写工具（**只在令牌被授予 `write:pages` 时出现**）：

| 工具 | 干什么 | 落库口径 |
| :-- | :-- | :-- |
| `pages_create` | 新建页面 | 草稿；免确认档下直接写 |
| `blocks_append` | 向现有页追加段落 | 同上 |
| `pages_importMarkdown` | 一次导入整篇 Markdown 成新页 | 同上 |
| `spaces_switch` | 切换 App 的活动空间（会改变你界面上看到的空间） | 同上 |
| `pages_update` | **整页替换** | ⚠️ **永远要你点确认** —— 免确认档也不放行 |

⚠️ 「免确认」是一个显式开关（默认**关**）；开着时每次写仍然**留一行审计** ✓。
唯一的例外是 `pages_update`：它是覆盖式写、这条路没有撤销与改前快照，所以**必须**走确认 ✓。
确认框里不再只有一句 summary：整页替换会显示「原文 N 字 → 新正文 M 字」和新正文开头 ✓
（2026-10-18 起，盲签改成看得见）。

### 引用与溯源（把结论锚到段落）

* `pages_get` 只给**文本窗口**，**不带块身份**；
* 要引用具体段落：先 `blocks_list` 拿各顶层块的 `blockId`，再在笔记里用块引用/嵌入；
* 这样页面被修改或删除时，引用会**显式失效**（而不是悄悄指错地方）——这是"可溯源"的底座。

默认只作用于**当前空间**；要跨空间读，把档位开到「只读（全部空间）」，用 `spaceId` 指定——它**不会**改变你界面上的活动空间。`spaces_switch` 是写能力（会改活动空间），一般不需要用。

⚠️ `coverage_report`（索引覆盖报告）**在这个面上**，但它由**前端宿主**交付：Rust 侧经"前端桥"转给前端算，
所以会走前端能力那条路——监听没装好时它可能先报就绪再空等 5s（`frontend_timeout`）。别把这句旧话当依据：
2026-10-29 B3 起它**已经列入** `capabilities/mcp-tools.json`（`node scripts/check-capabilities.mjs` 为准）。

## 安全边界（照实说）

| 项 | 实况 |
| :-- | :-- |
| 谁能连 | 只有本机 ✓（`127.0.0.1` ＋ `Origin`／`Host` 恰好回环才收 ✓ —— **前缀**匹配被明确拒绝 ✗，本仓真栽过 `127.0.0.1.evil.com` ✓） |
| 凭什么连 | `Authorization: Bearer <令牌>` ✓；令牌校验**在 App 那侧**（桥只转发 ✓） |
| 默认 | **关** ✓ |
| 关掉 | 请求立刻被拒 ✓；重新打开换新令牌 ✓ |
| 留痕 | **到达能力层的每一次调用都会写一行审计（含被拒绝的 ✓）**：`{"plugin_id":"external","source":"external:mcp-<会话号>","capability":"pages.search",…,"ok":false,"error_code":"space_unknown"}` ✓（会话号由令牌派生，**不含令牌原文** ✓）。⚠️ 但在**门口**就被挡下的那几种 —— 开关关着（`disabled`）／令牌不对（`401`）／`Origin`·`Host` 不是回环（`403`）／路径不是 `POST /call`（`404`）—— **不写审计** ✗：那时连「哪个外部会话」都还没认出来 ✓；⚖️ 而且通道那一层**刻意不碰审计账**（审计只有一本、只在能力层写 ✓，见 `check-mcp-audit-single-ledger` ✓）。 |
| 能绕开权限吗 | ⛔ 不能 —— 与插件走的是**同一处**鉴权（`dispatch_capability`）✓、同一本审计账 ✓ |

## 数据去哪儿（这一句必须精确）

| 事实 | 说明 |
| :-- | :-- |
| 笔记存在哪儿 | 本机 SQLite（`<应用数据>/spaces/*.db`）；ShuyoNote **不上传**、不联网也能用 ✓ |
| 外部 AI 能读到什么 | 由它自己决定调哪个工具 —— `pages_get` 可以整页取走，`files_read` 可以取附件文本 |
| 读到的内容去哪儿 | 进入**那个 AI 服务**的推理链路。它若是云端服务商，这部分内容就**离开了本机** ✓ |
| 想更严 | ① 用「只读」档；② 不用时关掉开关（旧令牌立刻失效 ✓）；③ 用本机模型的 AI 客户端 |

⇒ 对外表述请用「**本机存储 ＋ 只把 AI 读到的内容交给那个 AI**」，
⛔ 不要写成「数据不出本机」—— 那句话只在**存储**这一层成立 ✓。

## 排错（报错都是**如实**的，不假装成功 ✓）

| 你看到的 | 意思 | 怎么办 |
| :-- | :-- | :-- |
| `通道未开：没给 SHUYONOTE_MCP_PORT_FILE` | 桥没拿到连接信息 | 在 App 里打开开关，或把两个环境变量指对 ✓ |
| `连不上 App 的通道（127.0.0.1:x）` | App 没在听／开关被关了 | 看设置里那节的状态行 ✓ |
| `permission_denied: 缺 read:pages` | 令牌没被授予这个权限 | 令牌文件第 2 行补上权限，或换令牌 ✓ |
| `space_unknown: 无法确定当前空间` | App 里**没有打开任何空间** | 在 App 里点开一个空间再试 ✓ |
| `unknown_capability: …` | 该能力宿主不提供（例如 `coverage.report` ✓） | 用 `tools/list` 里列出的 ✓ |
| 客户端报 `Unexpected token` 之类 | 桥的 **stdout 被非协议内容污染** ✗ | 跑 `node scripts/check-mcp-bridge-stdout.mjs` ✓（日志一律走 stderr ✓） |

## 这个桥自己怎么验

```bash
node tools/shuyonote-mcp/judge-channel.mjs        # 转发面：15+ 条（真起一个假 App 通道 ✓）
node scripts/check-mcp-bridge-stdout.mjs          # 协议纯净 ＋ 版本协商（真起桥 ✓）
node scripts/check-mcp-bridge-dumb.mjs            # 桥必须"哑"：不碰库／不判权限／不写审计 ✓
```

三条都在 `pnpm verify` 的默认组里 ✓（另见 `docs/TESTING.md` 里那三行）。

