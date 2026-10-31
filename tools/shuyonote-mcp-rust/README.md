# shuyonote-mcp —— ShuyoNote 的**随包 MCP 桥**（Rust 版）

> **一句话**：一个**独立可执行文件**，把外部 MCP 客户端的 stdio 请求（`initialize` / `ping` /
> `tools/list` / `tools/call`）**原样转发**到 ShuyoNote 应用自己的本机通道（`127.0.0.1`）。
> 它**只搬运、不判权限、不碰数据库、不解密**：权限门、审计、草稿确认全部在 App 里。

- crate：`tools/shuyonote-mcp-rust`（`name = "shuyonote-mcp"`，`version = "0.1.0"`，edition 2021，`rust-version = "1.94"`，`license = "AGPL-3.0-only"`）
- 依赖只有 `serde_json`；release 开 `strip + lto + codegen-units=1` ⇒ 单文件约 **582 KB**（Windows 实测 582,656 B）
- **零运行时依赖**：不需要 Node、不需要 npm、不需要联网、不需要 env

## 1. 它是怎么进来的（为什么是独立 crate）

`src-tauri/build.rs`（tauri-build）在**编译期**就校验 `bundle.resources` 里的路径是否存在，
而桥的产物正是这次编译才生成的 ⇒ 放进 `src-tauri` 会变成"先有鸡还是先有蛋"
（实测 `cargo build --bin` 直接红：`resource path mcp\shuyonote-mcp.exe doesn't exist`）。

所以桥是**独立 crate**，由 `beforeDevCommand` / `beforeBuildCommand` 先编桥、再编 App：

```text
tauri.conf.json
  beforeDevCommand   : node scripts/build-mcp-bridge.mjs --debug && pnpm dev
  beforeBuildCommand : node scripts/build-mcp-bridge.mjs && pnpm build
```

## 2. 怎么构建

```bash
# 打包用（release）：编完自动拷进 dist/；这是 beforeBuildCommand 调的那条
node scripts/build-mcp-bridge.mjs

# 开发用（debug）：快，体积大一点；beforeDevCommand 调的是这条
node scripts/build-mcp-bridge.mjs --debug

# 也可以直接 cargo（产物在 target/<profile>/，需要自己拷到 dist/）
cargo build --release --manifest-path tools/shuyonote-mcp-rust/Cargo.toml --bin shuyonote-mcp
```

**产物**：`tools/shuyonote-mcp-rust/dist/shuyonote-mcp[.exe]`（`dist/` 与 `target/` 都被 gitignore；
非 Windows 上脚本会 `chmod 755`）。

## 3. 三平台随包位置（`bundle.resources`）

| 平台 | 配置文件 | 收进包里的落点 |
|---|---|---|
| Windows | `src-tauri/tauri.windows.conf.json` | `mcp/shuyonote-mcp.exe` |
| macOS | `src-tauri/tauri.macos.conf.json` | `mcp/shuyonote-mcp` |
| Linux | `src-tauri/tauri.linux.conf.json` | `mcp/shuyonote-mcp` |

⇒ 安装版里桥就是 `<resource>/mcp/shuyonote-mcp[.exe]`；**开发期**面板会优先填
`<仓库根>/tools/shuyonote-mcp-rust/dist/…`（见 `src-tauri/src/mcp_channel.rs` 的
`resolve_bridge_from`：① dev 产物 → ② `<resource>/mcp/…` → ③ 旧安装包的 Node 桥兜底）。

## 4. 端点从哪来（不需要 env）

桥每次调用都会去读 App 写在**应用数据目录**下的两个文件：

| 系统 | 默认位置 |
| :-- | :-- |
| Windows | `%APPDATA%\cn.shuyo.shuyonote\mcp\{port,token}` |
| macOS | `~/Library/Application Support/cn.shuyo.shuyonote/mcp/{port,token}` |
| Linux | `$XDG_DATA_HOME/cn.shuyo.shuyonote/mcp/{port,token}`（未设 ⇒ `~/.local/share/…`） |

优先级：`SHUYONOTE_MCP_PORT_FILE` / `SHUYONOTE_MCP_TOKEN_FILE`（单项覆盖）> `SHUYONOTE_MCP_HOME`（整个目录）
> 平台默认。三个都不配、App 也没开 ⇒ 报**「通道未开：读不到端口文件」**（⛔ 不猜、不假装连上）。

⭐ **每次 `tools/call` 都重读一次** ⇒ 应用换档、换令牌、换端口之后，**不需要重启外部客户端**，
下一次调用自动接上。（只有"新增了一个 server"才需要重启客户端 —— 那是客户端自己读配置的时机。）

## 5. 协议与输出纪律

- 方法：`initialize` / `ping` / `tools/list` / `tools/call`；**未知方法 ⇒ JSON-RPC `-32601`**；
  通知（无 `id`）不回包；`stdin` EOF ⇒ 按顺序退出；
- **stdout 只走协议**：任何日志/诊断一律走 **stderr**（污染 stdout 会让客户端报
  `Unexpected token` 之类）——门禁 `node scripts/check-mcp-bridge-stdout.mjs` 盯着这条；
- 工具面不在这里定义：`tools/list` 是 App 返回的 **34 读 ＋ 27 写 ＝ 61 条**
  （以 `capabilities/mcp-tools*.json` 与 `node scripts/check-capabilities.mjs` 为准）。

手动看一帧（桥自己就是一个 stdio 程序）：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tools/shuyonote-mcp-rust/dist/shuyonote-mcp.exe
```

## 6. 与 Node 桥（`tools/shuyonote-mcp/`）的关系

| | Rust 桥（本文） | Node 桥（`../shuyonote-mcp/`） |
|---|---|---|
| 谁在用 | **安装包默认**（2026-10-31 起） | 旧安装包兜底；`npx` 形态（连接器商店那条） |
| 要 Node 吗 | **不要** | 要 **Node ≥ 20** |
| 要联网吗 | **不要** | `npx` 形态首次要（拉 tgz） |
| 端点/令牌/工具面/协议 | **完全相同**（同一套 `{port,token}` 与同一份注册表） | 同左 |

两者**不并列运行**：面板只会填它找到的那一个（优先级见 §3）。面向用户的配置说明见
[`docs/mcp-external-ai.md`](../../docs/mcp-external-ai.md) §3（默认「随包」、可切「npx」）。

## 7. 自测与门禁

```bash
# crate 自测（8 条，含"假 App 通道"往返）
cargo test --manifest-path tools/shuyonote-mcp-rust/Cargo.toml

# 构建脚本 + 产物
node scripts/build-mcp-bridge.mjs --debug
```

- `src-tauri` 的 CI rust job 里有一步**单独**跑这个 crate 的 8 条单测（`--locked`）——
  它是独立 crate，`cargo test -p src-tauri` 那条碰不到它；
- `scripts/check-mcp-bridge-stdout.mjs`（基线 9 条）：桥的 stdout 只能出协议。

## 8. 边界（写清楚，免得被当成能力）

- ⛔ **不判权限**：档位、`granted`、`AI 不可见空间`、草稿确认、审计全在 App 侧；
- ⛔ **不碰库、不解密**：它没有数据库路径、没有空间密钥，令牌只用于向本机通道自证会话；
- ⛔ **不出本机**：只连 `127.0.0.1`；同网段设备连不上；
- ⛔ **不重试、不缓存**：一次调用一次转发，失败原样把 App 的错误码/文案透给客户端；
- ⚠️ **应用必须开着**：应用没在监听 ⇒ 报「通道未开」；那三条"前端桥"能力（`export_markdown` /
  `export_docpackage` / `coverage_report`）还要求**主窗口在**，否则回 `frontend_unavailable` /
  `frontend_timeout`（带原因，见用户指南 §7）。
