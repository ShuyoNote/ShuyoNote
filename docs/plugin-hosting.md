# 插件索引托管（community.shuyo.cn/plugins/）

> 2026-09-11 落地。**这份文档记录"为什么是这么配的"**，因为这里的每一条都不是随手选的，
> 而配错的表现全是**静默的**（索引被长缓存 = 新插件永远看不到；包路径写错 = 装不上）。

## 一、现状

| 项 | 值 |
|---|---|
| 索引 URL | `https://community.shuyo.cn/plugins/plugin-index.json` |
| 签名 URL | `https://community.shuyo.cn/plugins/plugin-index.json.minisig` |
| 磁盘位置 | `/var/www/shuyo-plugins/`（服务器 `121.199.8.24`） |
| 谁发的 | **nginx 直接发**（不是社区后端） |
| 缓存 | 索引与签名 `no-store`；`*.zip` 与 `*.zip.minisig` `immutable` 一年；其它 404 且 `no-store` |

社区公钥（用户订阅时填这把）：

```
untrusted comment: minisign public key 305A2DFBAC0773C1
RWTBcwes+y1aMIEdFdER5PCz4QsdYqVlBSMr6++SnWdoRUVI3DLcduK4
```

私钥在 Windows 侧的 `%USERPROFILE%\.minisign\community.key`（**不进仓库**）。

## 二、为什么单开 `/plugins/` 而不复用应用的 `/static/`

社区后端给 `/static/` 下**所有**文件统一发了：

```
cache-control: public, max-age=31536000, immutable     ← 连 404 都带这个头（实测）
```

而它是编译进 Rust 二进制里的，**没法按文件单独覆盖**。索引恰恰是唯一一个
"绝不能被长缓存"的文件 —— 索引被长缓存 = **新插件永远看不到、检查更新永远说没变化**，
而开发机上一切正常，只有真实用户那边慢慢变成"怎么一直没有新插件"。

所以按判据（`reply-6`）：**能按文件设头就用 `/static/`，否则单开路由** → 这里单开 `/plugins/`，
由 nginx 直接发文件，每个 path 的缓存头单独写死。

## 三、配置落在哪

四个 `location` 加在 `/etc/nginx/sites-enabled/community-shuyo.cn` 的 **443 server 块**里，
位于原有 `location / { proxy_pass ... }` **之前**。片段源文件在
[`docs/nginx-plugins.conf`](nginx-plugins.conf)（**那是源、不是线上活配置**）；
改前备份在服务器 `/etc/nginx/backups/community-shuyo.cn.bak-plugins-*`。

⚠️ **改这个文件必须保证没有 BOM**。第一次改的时候我用 PowerShell 的
`Out-File -Encoding utf8` 写入片段，它带了 BOM，nginx 报
`unknown directive "﻿location"` 而**拒绝启动**（幸好 `nginx -t` 拦住了）。
正确写法：

```powershell
$noBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("snippet.conf", $body, $noBom)
```

改完必须 `nginx -t` 再 `systemctl reload nginx`：**reload 前先测**，
否则配置错会让整个社区站点起不来（不只是插件这一块）。

## 四、发布新版本插件时怎么做

`downloadUrl` 带版本号（`<id>-<version>.zip`），且**资源不可覆盖重传** ——
所以新版本是**新文件**，旧文件保持不动（已订阅用户手里的索引可能还指向它）：

```bash
# 1) 在 Windows 侧产出（打包 + 发布者签名 + 索引签名）
node scripts/plugin-fragment.mjs --plugins examples/plugins --out <out> \
  --minisign "$env:USERPROFILE\.minisign-bin\minisign.exe" \
  --key "$env:USERPROFILE\.minisign\community.key" \
  --pub "$env:USERPROFILE\.minisign\community.pub" \
  --version <应用版本> --min-app-version <应用版本> \
  --url-base "https://community.shuyo.cn/plugins" --publisher "ShuyoNote 官方"
node scripts/community-index.mjs --fragment <out>/plugin-index.fragment.json --out <out> \
  --owner-id community --owner-name 数友社区 --owner-url https://community.shuyo.cn/ \
  --minisign "$env:USERPROFILE\.minisign-bin\minisign.exe" \
  --key "$env:USERPROFILE\.minisign\community.key"

# 2) 交出去之前先过应用真解析器（这是唯一的验收）
SHUYONOTE_INDEX_FIXTURE=<out>/plugin-index.json cargo test --lib external_index -- --ignored --nocapture

# 3) 上传（只增不改：新版本的 zip 是新文件名）
scp <out>/*.zip* <out>/plugin-index.json* root@121.199.8.24:/var/www/shuyo-plugins/
# 注意顺序：**先传新包，后传索引**。反过来的话，索引会在新包上传完成前就指向一个 404。
```

上传顺序这条是有理由的：索引里带 `size`/`sha256`，用户端下载后**逐字节校验**；
若索引先到而包还没到，那段时间里所有用户点安装都会拿到 404（而他们重试时索引已被缓存……不，
索引是 no-store，所以只要重试就好 —— 但没必要制造这个窗口）。

## 五、验收（每次发布后跑一遍）

```bash
# 缓存头三条规矩
curl -sSI https://community.shuyo.cn/plugins/plugin-index.json | grep -i cache-control   # no-store
curl -sSI https://community.shuyo.cn/plugins/plugin-index.json.minisig | grep -i cache-control  # no-store
curl -sSI https://community.shuyo.cn/plugins/<id>-<ver>.zip | grep -i cache-control      # immutable
curl -sSI https://community.shuyo.cn/plugins/typo.txt | grep -i cache-control            # no-store（404 不该被记）

# 索引签名
minisign -V -p community.pub -m plugin-index.json        # Signature and comment signature verified

# 每个包的 size/sha256 与索引一致（这是安装前应用会做的检查）
#    2026-09-11 实测：18 个条目，逐字节一致
```

## 六、密钥：**一把 key 同时承担两个角色**（已明确决定，2026-09-12）

规范里签名是**两件事**（索引签名 = "这份索引没被换过"；发布者签名 = "这个包是谁签的"）。
本项目第一方分发**用同一把 key 做这两件事**，并且这是**明确的选择**，不是省事漏掉的：

| 角色 | 用哪把 key |
|---|---|
| 索引签名（`plugin-index.json.minisig`） | `%USERPROFILE%\.minisign\community.key` |
| 每个包的发布者签名（条目里的 `publisherKey` + `signature`） | **同一把** `community.key` |

所以索引里 18 个条目的 `publisherKey` 就是第 16 行那把社区公钥，用户在安装确认里看到的
发布者指纹（`bcba-b1f3-0aa9-0e62`）与索引签名的指纹是**同一个**。
理由与代价写在 [`plugin-index-spec.md` §4.1](plugin-index-spec.md)：索引拥有者与包作者
本来就是同一个主体，两把 key 换不来不同的信任根，只多一份要保管与轮换的凭据。

上面第四节的发布命令**已经就是这么跑的**（`plugin-fragment.mjs --key community.key`、
`community-index.mjs --key community.key`），这一节只是把"为什么可以这样"钉下来。

### 因为同一把 key，三件事的后果与平常不同

1. **轮换不是内部操作**：换 key 会让**所有已装插件**触发 `publisher_key_changed`
   （TOFU 拒装，用户必须逐个重新确认），同时每个用户面板里填的索引公钥也要换。
   要换就得当作一次**对外公告**来做，不能顺手换。
2. **撤回它 = 关停整条链**：`revokedKeys` 里写这一把，会让这份索引**全部条目**不可安装、
   已装的全部暂停运行。它是"整条第一方分发链的总闸"，不是"某一个插件有问题"。
3. **公示一次就够**：发布说明里公示的新指纹同时覆盖两层——不会再出现
   "只换了其中一层、用户看不出来"这种半截状态。

### 两台机器都还没设的一件事（**发布链路上的静默坑**）

产出插件片段那一步要看 `SHUYONOTE_PUBLISHER_KEY`（发布者私钥）：

- **Windows 侧和 macOS 侧都没有设它**；
- 没设时**不会报错**，而是**静默跳过**产出片段 → 索引仍是旧的 18 个 →
  表现为"我发了新版，但用户那边看不到新插件"。
- 它指向的文件就是上表的 `community.key`。

发版流程里若这一步没跑，要去确认索引里的 `generatedAt` 有没有跟着更新，
而不是相信"发版脚本说成功了"。

