# 跨机器多端同步会合测试（Windows ⇄ Mac，服务器放 Mac）

> 为什么单独有这一篇：仓库里那两个 CI 脚本（`sync-regression.mjs` 14 断言 / `sync-collab-regression.mjs`
> 27 断言）是**同一台机器上用两个 device_id 模拟两端**——能证明服务端逻辑，但证明不了"两台真机器、
> 真网络、真客户端进程"这条链路。本篇用一个**会合协议**把这件事变成两端各自一条命令、各自出 PASS/FAIL，
> 而且**不需要事先约定谁先谁后**（两端各跑一次，互相等）。
>
> 适合它验的场景：官网「个人自建同步 ¥199 一次买断」——客户自己一台服务器、家里/公司两台机器，
> 需要确认"两边改的东西真的互相看得到"。

## 0. 分工

| 谁 | 做什么 |
|---|---|
| **Mac** | 跑测试服务端（监听 0.0.0.0）、签发一把设备密钥、跑它那一端的会合命令、**再用真客户端（Tauri 桌面版）肉眼确认一次** |
| **Windows** | 用 Mac 给的地址跑另一端会合命令、核对两边结果 |
| 判据 | 两端各打印的 `MDTEST_RESULT {...}`：`pass ≥ 6`、`fail = 0`、`peerSeen = true`、`bidirectional = true` |

两端**用同一把设备密钥、同一个空间**（个人自建就是这么用的：一把钥 = 那个空间的所有者）。
团队版也可以改用各自的账号会话 token（`--token <token>`），协议一样。

## 1. Mac 侧：起服务端（约 3 分钟）

```bash
# 私有仓（商业授权）——需要能访问 shuyonote-sync-server
cd ~/zhai/shuyonote-sync-server        # 或你放它的位置
git pull
cargo build --release                  # 只需一次；后端是纯 Rust + bundled SQLite，不需要 OpenSSL

mkdir -p ~/mdtest/backups
# ① 建空间 + 签发设备密钥（**明文只显示这一次**，请整行保存）
./target/release/shuyonote-sync-server \
  --db ~/mdtest/sync.db --issue-device-key \
  --space-name "多端会合" --label "mdtest"
#   → 打印 space_id / key_id / sk_…（后面两端都用这把 sk_）

# ② 起服务（0.0.0.0 才能被另一台机器访问；端口自定）
./target/release/shuyonote-sync-server --db ~/mdtest/sync.db --port 8787

# ③ 让防火墙放行 + 查自己的局域网地址（两个都记下来）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add ./target/release/shuyonote-sync-server 2>/dev/null || true
ipconfig getifaddr en0        # Wi-Fi 的 IP；有线可能是 en1/en5
```

自检（在 Mac 上）：

```bash
curl -s http://127.0.0.1:8787/health          # 期望 200
curl -s http://<上面那个 IP>:8787/health      # 期望 200；不通就是防火墙/不同网段
```

## 2. Mac 侧：跑它那一端（角色名 `mac`）

```bash
cd ~/zhai/ShuyoNote                 # 客户端仓库（公开）
git pull
node scripts/sync-multidevice.mjs \
  --server http://127.0.0.1:8787 \
  --token 'sk_……（第 1 步那把，整串）' \
  --role mac --peer windows --wait 300 --json
```

它会：① 写一页 `mdtest-mac`（标题 `MDTEST:mac:<时间戳>`）→ ② 轮询等 Windows 那一页 →
③ 改动 Windows 那一页、等对方回改自己这一页。**看到 `等待 windows 写入…` 就是在正常等** ✓。

> 两端**同时**跑最好（谁先启动都行，先启动的那端就是在等）。`--wait 300` 是每步最长等 5 分钟。

## 3. Mac 侧：再用**真客户端**确认一次（这一条比脚本更接近用户实际用法）

1. 打开 ShuyoNote 桌面版 → 同步面板 → 服务器填 `http://127.0.0.1:8787`；
2. 展开「**高级：手动填令牌 / 设备密钥**」→ 粘贴同一把 `sk_…` → **保存** → **同步**；
3. 期望：能列出「多端会合」这个空间、同步后能看到 `MDTEST:windows:…` 那一页，
   以及 `mdtest-mac` 自己那一页（标题尾巴上带着 `|seen-by-windows`，说明**对方改过你的页**）。

## 4. Windows 侧（我这边）

拿 Mac 给的地址跑：

```bash
node scripts/sync-multidevice.mjs \
  --server http://<Mac 的 IP>:8787 \
  --token 'sk_……（同一把）' \
  --role windows --peer mac --wait 300 --json
```

## 5. 判据与要回传的东西

两端各贴回**一行**就够（脚本最后会打印）：

```
MDTEST_RESULT {"role":"mac","peer":"windows","peerSeen":true,"bidirectional":true,"pass":6,"fail":0}
```

判过 = 两行都满足 `pass ≥ 6 / fail = 0 / peerSeen = true / bidirectional = true`。

**常见不通过的原因**（按踩过的顺序）：

| 现象 | 原因 / 怎么办 |
|---|---|
| `服务端可达（/health HTTP 0）` | 地址或端口不对；Mac 侧只监听了 127.0.0.1（要用默认的 `0.0.0.0`）；或防火墙没放行 |
| 一直停在"等待对方写入" | 另一端还没起、或**不在这把密钥的空间里**（团队版两端要用各自账号并都在同一空间）、或两端 `--role/--peer` 写反了（`--role mac --peer windows` 与 `--role windows --peer mac` 必须互相配对） |
| ② 通过但 ③ 不等 → `bidirectional: false` | 对方没在跑第二轮（用了 `--rounds 1`），或对方那一端已经退出 |
| 两端各自都 `peerSeen: true` 但时间戳很旧 | 说明拉的是历史数据而不是这次写入 ⇒ 清一下空间或换个 `--space` 再跑（脚本用固定 `entity_id`，重跑是覆盖） |

## 6. 这套测完还剩什么没覆盖

- **冲突合并**：两端同时改**同一页**时的 LWW 结果（脚本只验证"就地更新能到达"，不判定谁赢）；
- **附件**：跨机器的大附件传输（CI 的 `sync-regression.mjs` 覆盖了同一台机器上的附件 SHA-256 校验）；
- **断网重连 / 弱网**：一端断网改、恢复后补传（需要人工拔网线或防火墙规则，属另一次专项）。
