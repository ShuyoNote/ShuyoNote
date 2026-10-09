# 本地英汉词库（ECDICT）—— 数据不入库，走**能力包**

**这个目录里的词库数据不入库**（`src-tauri/.gitignore` 挡 `ecdict.csv` / `ecdict.db`）。
产出那份**待托管的能力包**由

```bash
node scripts/fetch-ecdict.mjs                # 全量：取回上游 CSV → 建 ecdict.db → 报 pack 的 sha256/字节数
node scripts/fetch-ecdict.mjs --check        # 只核对本地那份（不联网）
node scripts/fetch-ecdict.mjs --from-csv <路径>  # 用本地已下好的 CSV 建库（网络不稳时的备路）
node scripts/fetch-ecdict.mjs --sample 20000 # 只要前 N 条（HTTP Range，几 MB）⇒ 小样本库，供判据/联调
node scripts/fetch-ecdict.mjs --pack-out <路径>  # 另把 pack 复制到某处（要托管的那一份）
node scripts/fetch-ecdict.mjs --install      # 另把 pack 放进本机「能力包」目录（等价于"下载成功"）
node scripts/dictionary-bench.mjs            # 一条命令出三个读数：命中率／耗时／未收录怎么呈现
```

## ⭐ 口径：词库＝**能力包**，按需下载（owner 2026-10-09）

- ⛔ **不随安装包分发**（那份 CSV 实测 **65,933,428 字节**，随包会让安装包 +63MB ✗）。
- 走仓里**已有**的能力包链（`src-tauri/src/abilities.rs`：白名单 ＋ 钉死 sha256 ＋ fail-closed）：
  pack id = `ecdict-en-zh`，落点 `<app_data>/packs/ecdict-en-zh/ecdict-en-zh.bin`。
- 应用侧的路径解析只有两处（`dictionary.rs::current_db_path`）：
  ① `SHUYONOTE_ECDICT_DB`（**开发/判据**覆盖口）② 能力包。
  ⚠️ "资源目录随包"那条**已按 owner 拍板删掉**。

## 实测读数（2026-10-09，本机）

| 项 | 读数 | 怎么读到的 |
| :--- | :--- | :--- |
| 上游 | `skywind3000/ECDICT@bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`（blob `c4ade63e…`） | GitHub API |
| **许可** | **MIT**（`license.spdx_id = "MIT"`；`LICENSE` 首行 `MIT License`，`Copyright (c) 2025 Linwei`） | 原文见本目录 `LICENSE-ECDICT.txt` |
| CSV | 65,933,428 字节；sha256 `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf` | `fetch-ecdict.mjs` |
| **pack（ecdict.db）** | **89,735,168 字节；sha256 `5dc10a51f33a0a61d4cb4f368a220a50f8bccb8c2ff3488fdadd5eaaaea2bb31`；770,611 条词条** | 同上 ＋ `dictionary-bench.mjs` |
| 查询耗时 | 中位数 **0.223 ms** / p95 **0.62 ms**（9 次采样，含规范化） | `node scripts/dictionary-bench.mjs` |
| 命中率 | 英文样本 **5/5 = 100%**；中文术语与乱码 **全部如实未收录** | 同上 |

⚠️ 两个 sha256 与字节数**同时**写在 `src-tauri/src/abilities.rs` 的白名单与
`src/components/AbilitiesPane.tsx` 的清单里（`abilities.rs:21` 要求两处**同源**）。
⛔ 别手写一个没量过的哈希：`fetch-ecdict.mjs --check` 会把本地那份与 pin 对一遍。

## ⚠️ 今天**还没有**做的事（如实记下，别读成"已按需下载"）

1. ⛔ **包还没托管**：`AbilitiesPane.tsx` 里 `ecdict-en-zh` 的状态是 `not-available`
   （清单自己的纪律：只有 `url ＋ sha256` **真的能下一份**才算 `downloadable`）⇒
   托管到镜像仓（`mirror/ecdict/ecdict-en-zh.bin`）之后改成 `downloadable` 即可。
2. ⚠️ **85.6 MiB 走「base64 过 IPC」那条链太大**：能力包链的设计目标是 **3.8 MB 级**的 PDFium
   （`abilities.rs` 文件头逐字：IPC 传字节数组会更糟，base64 只放大 33%）；本词库 base64 后约 **120 MB**
   ⇒ 这条路对词库**不成立**。建议加一条 **Rust 侧下载**（同一份白名单 ＋ 钉死 sha256 ＋ fail-closed，
   且**先写 `.part` 再改名** ⇒ 半包不会被当成已就绪）—— 属设计改动，**待拍板**。
   ⛔ 无论走哪条路：**能力包下载路径里绝不许内置任何 token**（令牌只属开发侧脚本）。
3. ⚠️ **中文词典不在本期**（owner 拍"先英汉、后接中文"）：ECDICT 是英汉词典 ⇒
   "方法论"／"核聚变"这类中文术语**一定**查不到，界面因此**明说**"未收录 ⇒ 可走 AI"，
   ⛔ 不许静默空白、⛔ 不许编造释义（口径见
   [`docs/plans/2026-10-09-划词查词可行性评估.md`](../../../docs/plans/2026-10-09-划词查词可行性评估.md) §3-③/§3-④）。
