# shuyonote-mcp —— 一个「哑」桥：把 MCP 客户端接到 ShuyoNote

这个目录里只有一件事：让外部的 AI 助手（Claude Code、DSH／WorkBuddy 这类支持 **MCP** 的客户端）
能**只读**地访问你在 ShuyoNote 里的笔记。

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

* 打开时自动生成一枚**会话令牌**，写在 `<应用数据>\mcp\token`（第 1 行令牌、第 2 行逗号分隔的授权 ✓）；
* 实际端口写在 `<应用数据>\mcp\port` ✓；
* **关掉 ⇒ 每个请求立刻被拒** ✓，**重新打开会换一枚新令牌**（旧令牌作废 ✓）。

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

## 它能看到什么（今天：**只有这 7 个只读工具** ✓）

| 工具 | 干什么 |
| :-- | :-- |
| `pages_get` | 读一页的标题与正文纯文本（**必须看 `chars_total`** 才知道有没有读全 ✓） |
| `pages_search` | 按关键词搜页面 |
| `blocks_list` | 列这页的块（含数据库块的视图） |
| `backlinks_list` | 谁引用了这页 |
| `files_list` | 列附件 |
| `files_search` | 在附件抽取出的文本里搜 |
| `files_read` | 读附件的抽取文本（支持分页 ✓） |

⚠️ **没有写能力** —— 今天一个都没有 ✓（写随 M2；且按 owner 2026-10-06 的裁定：默认仍要用户确认，
另有一个免确认开关，但**一定留痕** ✓）。

⚠️ `coverage_report`（索引覆盖报告）**不在这个面上** ✓ —— 它由 App 内部（前端宿主）实现，
外部经桥调不到，所以清单里**刻意不列它** ✗（列了就是"面里有个调不通的工具" ✓，
`check-capabilities.mjs` 有一条反向断言钉这个 ✓）。

## 安全边界（照实说）

| 项 | 实况 |
| :-- | :-- |
| 谁能连 | 只有本机 ✓（`127.0.0.1` ＋ `Origin`／`Host` 恰好回环才收 ✓ —— **前缀**匹配被明确拒绝 ✗，本仓真栽过 `127.0.0.1.evil.com` ✓） |
| 凭什么连 | `Authorization: Bearer <令牌>` ✓；令牌校验**在 App 那侧**（桥只转发 ✓） |
| 默认 | **关** ✓ |
| 关掉 | 请求立刻被拒 ✓；重新打开换新令牌 ✓ |
| 留痕 | **到达能力层的每一次调用都会写一行审计（含被拒绝的 ✓）**：`{"plugin_id":"external","source":"external:mcp-<会话号>","capability":"pages.search",…,"ok":false,"error_code":"space_unknown"}` ✓（会话号由令牌派生，**不含令牌原文** ✓）。⚠️ 但在**门口**就被挡下的那几种 —— 开关关着（`disabled`）／令牌不对（`401`）／`Origin`·`Host` 不是回环（`403`）／路径不是 `POST /call`（`404`）—— **不写审计** ✗：那时连「哪个外部会话」都还没认出来 ✓；⚖️ 而且通道那一层**刻意不碰审计账**（审计只有一本、只在能力层写 ✓，见 `check-mcp-audit-single-ledger` ✓）。 |
| 能绕开权限吗 | ⛔ 不能 —— 与插件走的是**同一处**鉴权（`dispatch_capability`）✓、同一本审计账 ✓ |

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
