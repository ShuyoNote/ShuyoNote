# 撤两层防抖的**代价**（DEC-3「先量」）—— 落库/上传频率、单次开销、最坏上限

> 状态：**已量**（2026-09-30）｜依据：本文自己的三个脚本读数（§6 全文可粘贴复现）＋ 两条既有实测指针
> 由来：owner 已拍 `DEC-3`（撤两层防抖），而承诺的口径是「**先量再撤**」；`enterprise-edition-tasks` 的 `T3`
> 自己就写着「⚠️ 撤防抖的代价（落库/上传频率与耗电）依据文档里没有读数 ⇒ 拍之前应先量」。
> ⚠️ **本文只量与测：产品代码一个字节没改**（防抖仍在 `600ms` / `400ms` 上，见 §1）。
> ⚠️ 机器：Apple Silicon 16 核 / 48GB / macOS｜仓库 HEAD `003d32a5`｜Node v24.21.0（harness 自带那份）。

---

## 0. 一句话（先给判决要用的三句）

```text
① 单次开销**不大**：`save_page` 的 SQLite 那半 p50 ≈ 0.14ms（2 千字页）/ 0.26ms（8 千字页），
   每次编辑本来就写的那笔 page_crdt BLOB ≈ 0.01ms；一轮上传（真服务端、loopback）p50 4~6ms。
   ⇒ **SQLite/引擎不是拦路虎**。
② 代价在【次数 × 每次带的是整页】：撤掉后落库次数 = 编辑事件数（平均打字 254 次/分、快速 603 次/分、
   **按住键 1800 次/分**），而每次落库的 outbox 载荷是 **19.3KB / 76.7KB**（2 千 / 8 千字页，
   本机实测字节）⇒ 平均打字 4.7~18.6 MB/分，猛打 30 秒 **16.6~65.8 MB**。
③ ⚠️ **最坏情况的"上限"不能靠"保留一个小去抖"拿到**：尾沿去抖在**连续输入下永不触发**
   （每次按键都把它重置）⇒ 要么接受 per-key，要么把这一层改成**节流**（例如"至少隔 100ms 发一次"，
   那才给得出上限 600 次/分）。今天这条路上**没有任何节流**。
```

---

## 1. 今天那两层到底是什么（逐句读代码，带行号）

```text
【保存层 · 600ms】`src/App.tsx:420-432` 的 `persist(patch)`：
   `pendingSaveRef = patch` ⇒ `debounceRef = setTimeout(flushPendingSave, 600)`（**尾沿去抖**，每次编辑重置）
   ⇒ 到点时 `flushPendingSave()`（`:381-418`）：`api.savePage({id, ...patch})`
【上传层 · 400ms】`src/App.tsx:205` 的 `LOCAL_EDIT_UPLOAD_DEBOUNCE_MS = 400` ＋ `:558-577` 的 effect：
   `onAnyLocalEdit(() => { … setTimeout(async () => { await flushPendingSave(); requestAutoSyncRound(); }, 400) })`
   ⇒ ⚠️ **先 flush 再跑一轮**（注释逐字：「带状态的那条 outbox 记录是页面保存那一刻才产生的」）
【轮次合并】`src/App.tsx:143-196`：`syncRoundBusy` 忙 ⇒ 记 `syncRoundPending`，跑完**串行**补一轮
   （不是并发、也不是丢弃）⇒ 上传次数天然被"一轮的时长"合并
【每一次按键**还**发生什么（与去抖无关）】
   · Lexical `onChange`（`src/editor/Editor.tsx:653-657`）⇒ 序列化 ＋ `persist(patch)` ⇒ 重置上面那个 600ms
   · `onLocalEdit`（`src/lib/crdt/yDocBridge.ts:320-325`）⇒ `src/editor/Editor.tsx:573` 的 `b.persist()`
     ⇒ `pageBinding.persist()`（`:410-412`）⇒ `api.savePageState` ⇒ **写整块 CRDT 状态 BLOB（无去抖）**
   ⇒ ⇒ 撤防抖**不改变**序列化与那笔 BLOB 写（今天就已经每键一次），改变的是**落库次数与上传次数**
```

### ⚠️ 1.1 两条"读代码才知道"的耦合（决定了"只撤一层"做不到）

```text
① **上传那条路会 flush 待保存** ⇒ 只要「上传去抖 < 保存去抖」，保存去抖就**形同不存在**
   今天正是 `400 < 600` ⇒ **今天"每一次落库"其实都是由上传那一层触发的**（模型里两者次数相等，见 §3）
② ⇒ 所以"**只撤上传那一层**"在本形状下**等价于"两层都撤"**（每次编辑都 flush 一次保存）；
   想只撤一层，得同时改 `flushPendingSave` 的语义（那是 `T3` 的设计问题，不在本文范围）
```

---

## 2. 打字模型（**逐条**，可照着复算）

> 一次"编辑事件"＝ 一次 `onChange`（⇒ `persist`）＋ 一次 `onLocalEdit`（⇒ 上传那层），
> 两条都来自同一次按键（`Editor.tsx:573` 与 `App.tsx:560` 各订阅一次）。

| # | 模型 | 参数（逐字） | 窗口 |
|---|---|---|---|
| ① | 一般打字 | 5 字/秒（间隔 200ms）；每 40 字停 **1.5s** | 300s（1280 次编辑） |
| ② | 快速打字 | 12 字/秒（间隔 83ms）；每 60 字停 **1.0s** | 300s（3060 次） |
| ③ | **猛打（最坏）** | **按住键 30 字/秒**（间隔 33ms）连续 **30s**，之后空转 30s | 60s（901 次） |
| ④ | 粘贴大段 | **1 次编辑**（2 000 字），之后空转 60s | 60s（1 次） |
| ⑤ | 连续打后停手（对照） | 5 字/秒连续 30s，之后空转 30s | 60s（150 次） |

⚠️ **30 字/秒的出处与不确定性**：macOS 键重复速率可调到 ~15–30 次/秒（系统设置里"按键重复"最快档）。
本文按 **30 次/秒**取最坏；若实际是 15 次/秒，把 §3/§5 的猛打数字**除以 2** 即可（本文另给了 15 的解析式）。

---

## 3. ① 对照表：今天 vs 撤掉后（落库次数/分 ｜ 上传次数/分）

### 3.1 主表（`roundMs = 6ms`＝本机实测的 8 千字页整轮 p95，见 §4.2）

| 模型 | 编辑次数 | **今天** 落库/分 ｜ 上传/分 | **撤两层后** 落库/分 ｜ 上传/分 |
|---|---|---|---|---|
| ① 一般打字 | 1280 / 300s | **6 ｜ 6** | **254 ｜ 254** |
| ② 快速打字 | 3060 / 300s | **10 ｜ 10** | **603 ｜ 603** |
| ③ 猛打（按住键 30s） | 901 / 60s | **1 ｜ 1**（⚠️ 猛打期间 **0**，停手后才 1 次） | **901 ｜ 901** |
| ④ 粘贴 2 000 字 | 1 / 60s | **1 ｜ 1** | **1 ｜ 1** |
| ⑤ 连续打 30s 后停手 | 150 / 60s | **1 ｜ 1** | **150 ｜ 150** |

**读法**：今天的数字**几乎只由"停顿"决定**（尾沿去抖：连续输入期间一次都不触发；停顿 ≥400ms 才落一次）
⇒ 所以 ①"每 8 秒一批＋停 1.5s"＝ 6 次/分；③"按住键"＝ **0 次**（这一条正是 `T3` 要修的病）。
撤掉后 = 编辑事件数（平均 254/分、快速 603/分、猛打 901/60s ⇒ 外推 **1800/分**）。

### 3.2 变体表（**两层可以分开撤** ⇒ 撤哪一层，数字完全不同）

| 变体 | ① 一般打字 | ② 快速打字 | ③ 猛打 |
|---|---|---|---|
| 今天（保存 600 ＋ 上传 400） | 6 / 6 | 10 / 10 | 1 / 1 |
| **只撤保存**（0 ＋ 400） | **254 / 6** | **603 / 10** | **901 / 1** |
| **只撤上传**（600 ＋ 0） | **254 / 254** | **603 / 603** | **901 / 901** |
| **两层都撤**（0 ＋ 0） | **254 / 254** | **603 / 603** | **901 / 901** |
| 中间档：保存 600 ＋ 上传 **150** | 253 / 253 | 10 / 10 | 1 / 1 |
| 中间档：保存 600 ＋ 上传 **250** | 6 / 6 | 10 / 10 | 1 / 1 |
| 中间档：保存 600 ＋ 上传 **100** | 254 / 254 | 10 / 10 | 1 / 1 |

（每格 = **落库/分 ÷ 上传/分**）

⚠️ **两条关键读数**：
1. **"只撤上传" ≡ "两层都撤"**（原因见 §1.1①）⇒ 想只撤上传，必须同时动 `flushPendingSave` 的语义；
2. **中间档的中间档**：`上传 150ms` 在 ① 下等于"每键"（200ms 间隔 > 150ms ⇒ 每键都触发），
   在 ②③ 下**永不触发**（83ms / 33ms 间隔 < 150ms ⇒ 一直被重置）⇒ **尾沿去抖给不出"速率上限"**，
   它只给"停手后多久发"。要有上限 ⇒ 用**节流**（§5.3）。

---

## 4. ② 单次开销（实测；说不清的明说）

### 4.1 落库那几步（`save_page`）的 SQLite 成本 —— **同引擎近似**（⚠️ 见方框）

`node:sqlite`（同一个 SQLite 引擎）＋ 产品同样的 WAL / `synchronous=NORMAL` ＋ 产品同样的语句与表形状
（`versions::snapshot_before_save` 的 SELECT/INSERT、`doc_content::write` 的 UPDATE、
`sync::record_page_upsert` → `record_change` 的 INSERT、以及 `search::sync_fts` 的 FTS5 DELETE+INSERT）：

| 步骤（2 千字页） | 字节 | p50 / p95 (ms) |
|---|---|---|
| ① 快照去重的 SELECT | — | 0.038 / 0.046 |
| ② 版本快照 INSERT（**整份内容副本**） | 12 011 | 0.052 / 0.061 |
| ③ 页面行 UPDATE | — | 0.023 / 0.046 |
| ④ outbox 记录 INSERT（**整页载荷**） | 19 294 | 0.064 / 0.085 |
| **①+②+③+④ ≈ 一次 `save_page` 的 SQLite 那半** | — | **0.143 / 0.168** |
| ⑤ **每次编辑就写**的 `page_crdt` 状态 BLOB | 2 000 | 0.012 / 0.021 |
| `derive` 的 FTS5 那一半（trigram 重建） | 6 000 | 0.128 / 0.216 |

| 步骤（8 千字页） | 字节 | p50 / p95 (ms) |
|---|---|---|
| ① 快照去重的 SELECT | — | 0.037 / 0.056 |
| ② 版本快照 INSERT | 48 011 | 0.085 / 0.153 |
| ③ 页面行 UPDATE | — | 0.048 / 0.110 |
| ④ outbox 记录 INSERT | 76 690 | 0.127 / 0.172 |
| **①+②+③+④ ≈ 一次 `save_page` 的 SQLite 那半** | — | **0.258 / 0.421** |
| ⑤ 每次编辑就写的 `page_crdt` BLOB | 8 000 | 0.010 / 0.024 |
| `derive` 的 FTS5 那一半 | 24 000 | 0.365 / 0.428 |

> ⚠️ **这一档是"同引擎近似"，不是产品进程内实测**：产品的 `save_page` 走 **rusqlite（进程内）＋ Tauri IPC**，
> 本机**量不了**（要起真 App；桩会把 IPC 那一半吃掉 —— `client-frame-rate-loadtest` §8 已如实记过同一件事）。
> 且它**不含**：Tauri IPC（每次 `save_page` 一次）、`stamp_block_revs`、`fetch_page`、
> **`blocks::rebuild_block_graph`（JSON 解析 ＋ blocks/backlinks 重建）**——最后这一项要 Rust 的解析器，本文量不了。
> ⇒ 这一档给的是**下界/量级**：**引擎那半小到可以忽略**（哪怕猛打 30 次/秒，8 千字页也只有 30×0.26ms = 7.8ms/s）。

### 4.2 一轮上传（**真服务端**，HTTP over loopback；⚠️ 不含客户端进程内那半）

```
真服务端：cargo build（debug 二进制，`shuyonote-sync-server` v1.2.4）＋ 临时库；
量 N=30 轮：`POST /push`（一条变更）＋ `GET /pull?since=<水位>`（增量拉）
```

| 载荷档 | 载荷字节 | push p50/p95/max (ms) | **整轮** p50/p95/max (ms) |
|---|---|---|---|
| 空档：没有 `crdt_state`（老载荷形状） | 155 | 1.8 / 2.3 / 2.3 | 3.4 / 4.1 / 4.1 |
| 2 000 字页（state ≈2.1KB） | 19 306 | 1.9 / 2.2 / 2.3 | **4.0 / 4.3 / 4.4** |
| 8 000 字页（state ≈8.1KB） | 76 702 | 2.4 / 2.6 / 3.5 | **5.7 / 6.0 / 6.9** |
| "无事可推"的一轮（`accepted=0` ＋ 增量 pull） | — | — | 3.3 / 3.6 / 4.0 |

> ⚠️ **同一形状的两个夹具**：§4.1 那份载荷是 **19 294 B / 76 690 B**，本表是 **19 306 B / 76 702 B**
> —— 差的 **12 字节**来自两个脚本里 `stamp.ms` 的位数不同（同一个字段、同一个形状）。**不是两套数字打架。**

⚠️ **为什么这里的数这么小**：loopback（没有 Wi-Fi 往返、没有真网络）、payload 是**明文 JSON**、
且**不含客户端侧**那一段（读 outbox ＋ `save_page` ＋ 加密 ＋ IPC）。需求 §9.5 给的"上传 50~200ms"里
大头是**真网段 RTT**；⇒ **真网络上"一轮"的上限应当按 50~200ms 估**（那就是 300~1200 轮/分），
**本文没有真网络读数**（如实）。

### 4.3 一次编辑**已经**在付的那笔（撤不撤都一样，写下来免得算重）

| 项 | 读数 | 出处 |
|---|---|---|
| `exportState()`（整块状态序列化） | p50 **<0.03ms**（≤8 千字） | `client-frame-rate-loadtest` §3.3（真浏览器实测） |
| 状态体积 | **≈1 字节/字**（500 字 610B … 8 000 字 8 110B） | 同上 §3.3 |
| 写 `page_crdt` BLOB（每键一次） | p50 0.010~0.012ms | 本文 §4.1 ⑤（同引擎近似） |
| Lexical 序列化 ＋ `getTextContent` | **没量**（本文量不了；它是每键都跑的既有成本） | — |

---

## 5. ③ ⚠️ 最坏情况（**owner 要拿它决定撤不撤**）

### 5.1 速率的**上限**（按住键 30 字/秒）

```text
撤两层后：
  · 落库 = 编辑事件数 ⇒ 30 × 60 = **1800 次/分**（15 字/秒 ⇒ 900 次/分）
  · 上传 = min(编辑速率, 1/一轮时长)：
      本机 loopback 一轮 4~6ms ⇒ 上限 10000~15000 次/分（＝不成为约束）
      真网络按 50~200ms/轮 ⇒ **300~1200 次/分**（超出部分被 `syncRoundPending` 合并成"跑完再来一轮"）
今天：猛打期间 **0 次落库 / 0 次上传**（尾沿去抖永不触发）⇒ 代价是"**对面 30 秒看不到**"
```

### 5.2 字节与磁盘（把 §4 的"每次"乘上"次数"；单条字节为实测）

| 场景 | 档 | outbox 写入 | `page_versions` 快照写入 |
|---|---|---|---|
| 今天·一般打字（6 次/分） | 2 千字页 | 0.11 MB/分 | 0.07 MB/分 |
| 今天·一般打字（6 次/分） | 8 千字页 | 0.44 MB/分 | 0.27 MB/分 |
| 撤后·一般打字（254 次/分） | 2 千字页 | **4.67 MB/分** | 2.91 MB/分 |
| 撤后·一般打字（254 次/分） | 8 千字页 | **18.58 MB/分** | 11.63 MB/分 |
| 撤后·快速打字（603 次/分） | 2 千字页 | 11.10 MB/分 | 6.91 MB/分 |
| 撤后·快速打字（603 次/分） | 8 千字页 | 44.10 MB/分 | 27.61 MB/分 |
| **撤后·猛打 30 秒（900 次）** | 2 千字页 | **16.56 MB**（30 秒内） | 10.31 MB |
| **撤后·猛打 30 秒（900 次）** | 8 千字页 | **65.82 MB**（30 秒内） | 41.21 MB |

⚠️ **另外两条同源的代价（读代码即成立，不必再量）**：

```text
① **一次 push 的请求体上限**：`do_push`（`sync.rs:2225-2229`）一次取 **≤500 行** ⇒
   500 × 19.3KB ≈ **9.2 MB**（2 千字页）／ 500 × 76.7KB ≈ **36.6 MB**（8 千字页）**一个请求**。
   猛打 30 秒攒下的 900 行 ⇒ 至少要两次这种请求。
② **版本历史被"用光"**：`MAX_VERSIONS_PER_PAGE = 50`（`versions.rs:7`），且去重只跳过"与最新一条逐字相同"
   ⇒ 打字时每次都插一条 ⇒ 撤防抖后 50 个槽位**覆盖最后几秒**（30 次/秒时约 1.7 秒）——
   而今天 6 次/分时 50 个槽位覆盖 ≈8 分钟。⇒ **撤防抖会让"历史版本"这个功能事实上失效**（不是性能，是语义）。
```

### 5.3 ⚠️ 一条方法学结论（决定"怎么撤"）

```text
**尾沿去抖永远给不出连续输入下的速率上限**（每次输入都重置它）。
  · 想"边打边到"又要有上限 ⇒ 必须是**节流**（throttle：例如"至少间隔 T ms 发一次 ＋ 尾沿补一发"）；
    上限 = 60000/T 次/分：T=100ms ⇒ 600/分；T=250ms ⇒ 240/分；T=500ms ⇒ 120/分。
  · 今天这条路上**没有任何节流**（`persist` 与那个 effect 都只有 `setTimeout` 去抖）。
⇒ 所以"撤两层防抖"这件事，**真正要定的不是'撤不撤'，而是'撤掉之后用什么给上限'**。
```

---

## 6. 复现命令（可粘贴）

```bash
# 0) 环境（本机 cargo 不在 PATH 上）
export PATH="$HOME/.cargo/bin:$PATH"

# 1) 频率模型（① 对照表 ＋ 变体表 ＋ 最坏上限）
#    参数 = 一轮的时长（ms）；本机实测 8 千字页整轮 p95 ≈ 6ms
node /tmp/d3/debounce-model.mjs 6      # 主表
node /tmp/d3/debounce-model.mjs 60     # 敏感性：把真网络 RTT 算进来

# 2) 一轮上传的真实耗时（真服务端 · loopback）
cd /Users/shuyo/zhai/repos/shuyonote-sync-server && cargo build          # debug 二进制
rm -f /tmp/d3/sync.db*
./target/debug/shuyonote-sync-server --bind 127.0.0.1 --port 8921 \
    --db /tmp/d3/sync.db --backup-dir /tmp/d3/backups &> /tmp/d3/server.log &
curl -s http://127.0.0.1:8921/health          # ⇒ ok
node /tmp/d3/round-cost.mjs http://127.0.0.1:8921
kill $(lsof -nP -iTCP:8921 -sTCP:LISTEN -t)        # 停掉自己起的那个（别留后台进程）

# 3) 落库几步的 SQLite 成本（同引擎近似）
node /tmp/d3/sqlite-write-cost.mjs
```

⚠️ **脚本本体**在 `/tmp/d3/`（一次性，不提交；与 `client-frame-rate-loadtest` 同一处置）。
⇒ 为了"照本文也能再跑一遍"，三个脚本的全文附在 **§8 附录**（可直接粘回 `/tmp/d3/`）。

---

## 7. 拿不准 / 量不了的（点名 ＋ 为什么）

| # | 量不了的 | 为什么 | 影响 |
|---|---|---|---|
| 1 | **`save_page` 的进程内真实耗时**（含 Tauri IPC ＋ rusqlite ＋ `stamp_block_revs` ＋ `fetch_page`） | 要起真 App 或改产品代码加计时；桩会把 IPC 那一半吃掉（`client-frame-rate-loadtest` §8 同款理由） | §4.1 是**下界** ⇒ "单次开销小"这个结论**可能被 IPC 推翻**；但 IPC 是**每键已经付过**的（`save_page_state` 今天就是每键一次）⇒ 撤防抖**不会新增 IPC 的种类**，只增加**次数** |
| 2 | **`blocks::rebuild_block_graph`（JSON 解析 ＋ blocks/backlinks 重建）** | 要 Rust 解析器；node:sqlite 复现不了 | 8 千字页每次落库可能要解析 24KB JSON ＋ 重写块表 ⇒ 这是 §4.1 之外**最大的一块未测量**，也是"能不能撤"最该补的一条 |
| 3 | **真网络的"一轮"耗时**（50~200ms 是需求 §9.5 的估） | 要真网段／服务端异地 | §5.1 的上传上限（300~1200 次/分）建立在这个**估**上 |
| 4 | **耗电与移动端**（`T3` 原文点名的"耗电"） | 要真机（安卓那台最要紧） | 本文只有**频率与字节**，没有 mA/电量读数 ⇒ 与既有待办 `M6`（量每 5 秒网格轮询的耗电）**同一条** |
| 5 | **Lexical 序列化每键成本** | 要真浏览器 ＋ 真编辑器 | 它是**撤不撤都在付**的既有成本，不影响对照，但会抬高"绝对开销" |
| 6 | **"净等待"的端到端墙上时间**（编辑 ⇒ 对端看到） | 要两台真机 | 本文只给"次数与单次耗时"；端到端仍归 `T3` 的真机验收 |
| 7 | **一次编辑事件 = 一次按键**这个假设 | 读代码得到（`Editor.tsx:653` 的 `onChange` 与 `yDocBridge.ts:320` 的 update 监听各一次）；IME 组字期间的批次数**没量** | 中文输入法一次上屏可能是一个批次 ⇒ 实际编辑事件数**可能低于**按键数（模型按 1 键 = 1 事件，偏保守） |

---

## 8. 附录：三个脚本全文（粘贴回 `/tmp/d3/` 即可重跑）

### 8.1 `/tmp/d3/debounce-model.mjs`

```js
// DEC-3「先量」· 频率模型（离散事件模拟）
//
// 语义**逐句照代码**（不是凭印象）：
//   · 保存那一层：`persist(patch)` ⇒ `pendingSave = patch`；600ms **尾沿去抖**（`src/App.tsx:427-431`）
//   · 上传那一层：`onAnyLocalEdit` ⇒ 400ms **尾沿去抖**（`src/App.tsx:205 / 560-570`）
//       到点时：**先 flush**（`flushPendingSave`：取消保存那个定时器、若有 pending 就存一次）
//       ⇒ **再** `requestAutoSyncRound()`
//   · 轮次合并：`syncRoundBusy` ⇒ 忙则记 `syncRoundPending`，跑完**串行**补一轮（`App.tsx:143-196`）
//   · 编辑源：正文每个 `onChange`（Lexical 每个批次）⇒ `persist`；每个 `onLocalEdit` ⇒ 上传那层
//       ⇒ **一次按键同时给两层各一个信号**（两条路都在 App.tsx 里，见 `onEditorSave` 与那个 effect）
//
// 用法：node /tmp/d3/debounce-model.mjs [roundMs]
import { performance } from "node:perf_hooks";

const SAVE_DEBOUNCE_MS = 600; // App.tsx:428-431
const UPLOAD_DEBOUNCE_MS = 400; // App.tsx:205
const ROUND_MS = Number(process.argv[2] ?? 40); // 实测（round-cost.mjs）；默认先给 40ms

/** 打字模型：返回 [t_ms, …] 的编辑事件时刻（一次编辑 = 一次 persist ＋ 一次 onLocalEdit）。 */
const models = {
  "① 一般打字 5 字/秒（每 40 字停 1.5s）": () => {
    const out = [];
    for (let t = 0; t < 300_000; ) {
      for (let i = 0; i < 40; i++) {
        out.push(t);
        t += 200;
      }
      t += 1500;
    }
    return { edits: out, windowMs: 300_000, burst: "连续 8 秒一批" };
  },
  "② 快速打字 12 字/秒（每 60 字停 1.0s）": () => {
    const out = [];
    for (let t = 0; t < 300_000; ) {
      for (let i = 0; i < 60; i++) {
        out.push(t);
        t += 83;
      }
      t += 1000;
    }
    return { edits: out, windowMs: 300_000, burst: "连续 5 秒一批" };
  },
  "③ 猛打：按住键 30 字/秒 × 30s，然后空转 30s（最坏）": () => {
    const out = [];
    for (let t = 0; t < 30_000; t += 1000 / 30) out.push(Math.round(t));
    return { edits: out, windowMs: 60_000, burst: "30 秒不停" };
  },
  "④ 粘贴 2000 字（1 次编辑）后空转 60s": () => ({
    edits: [0],
    windowMs: 60_000,
    burst: "一次大编辑",
  }),
  "⑤ 连续打 30s（5 字/秒）后空转 30s（对照：今天这条路工作得不错的场景）": () => {
    const out = [];
    for (let t = 0; t < 30_000; t += 200) out.push(t);
    return { edits: out, windowMs: 60_000, burst: "30 秒连续" };
  },
};

/**
 * 离散事件模拟。返回该窗口内的「落库次数」「上传轮次」。
 * ⚠️ 去抖为 0 时按"编辑后立刻"处理 —— 同一时刻两条路的先后不影响落库计数
 *    （谁先都只存一次：另一条路要么没有 pending、要么定时器已被 flush 取消）。
 */
function simulate(edits, { saveMs, uploadMs, roundMs, windowMs }) {
  let pendingSave = false;
  let saveGen = 0;
  let uploadGen = 0;
  let busy = false;
  let pendingRound = false;
  const saves = [];
  const uploads = [];
  const q = []; // {at, seq, kind}
  let seq = 0;
  const push = (at, kind) => q.push({ at, seq: seq++, kind });
  let i = 0;
  while (i < edits.length) push(edits[i++], "edit");
  // 轮次结束事件也进队列（由 'upload'/'roundEnd' 自己再 push）
  for (;;) {
    if (!q.length) break;
    q.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const ev = q.shift();
    if (ev.at > windowMs) break;
    if (ev.kind === "edit") {
      pendingSave = true;
      saveGen += 1;
      uploadGen += 1;
      const g1 = saveGen;
      const g2 = uploadGen;
      push(ev.at + saveMs, `save:${g1}`);
      push(ev.at + uploadMs, `upload:${g2}`);
    } else if (ev.kind.startsWith("save:")) {
      const g = Number(ev.kind.slice(5));
      if (g !== saveGen) continue; // 被更晚的编辑或 flush 取消
      if (pendingSave) {
        saves.push(ev.at);
        pendingSave = false;
      }
    } else if (ev.kind.startsWith("upload:")) {
      const g = Number(ev.kind.slice(7));
      if (g !== uploadGen) continue;
      // 先 flush：取消保存定时器；有 pending 就现在存
      if (pendingSave) {
        saves.push(ev.at);
        pendingSave = false;
        saveGen += 1;
      }
      // 再请求一轮（忙 ⇒ 合并成"跑完再来一次"）
      if (busy) {
        pendingRound = true;
      } else {
        busy = true;
        uploads.push(ev.at);
        push(ev.at + roundMs, "roundEnd");
      }
    } else if (ev.kind === "roundEnd") {
      busy = false;
      if (pendingRound) {
        pendingRound = false;
        busy = true;
        uploads.push(ev.at);
        push(ev.at + roundMs, "roundEnd");
      }
    }
  }
  return { saves, uploads };
}

const fmt = (n) => String(Math.round(n)).padStart(6);
console.log(`# DEC-3 频率模型（roundMs = ${ROUND_MS}ms）\n`);
console.log(
  "模型".padEnd(58) +
    "窗口s".padStart(6) +
    "编辑".padStart(7) +
    "今天落库/分".padStart(12) +
    "今天上传/分".padStart(12) +
    "撤后落库/分".padStart(12) +
    "撤后上传/分".padStart(12),
);
for (const [name, make] of Object.entries(models)) {
  const { edits, windowMs } = make();
  const today = simulate(edits, {
    saveMs: SAVE_DEBOUNCE_MS,
    uploadMs: UPLOAD_DEBOUNCE_MS,
    roundMs: ROUND_MS,
    windowMs,
  });
  const after = simulate(edits, { saveMs: 0, uploadMs: 0, roundMs: ROUND_MS, windowMs });
  const mins = windowMs / 60_000;
  console.log(
    name.padEnd(58) +
      fmt(windowMs / 1000) +
      fmt(edits.length) +
      fmt(today.saves.length / mins) +
      fmt(today.uploads.length / mins) +
      fmt(after.saves.length / mins) +
      fmt(after.uploads.length / mins),
  );
}

// 最坏上限（解析式，与模型无关）
console.log("\n# 最坏上限（解析式）");
console.log(`  撤后落库 = 编辑事件数（1 编辑 ⇒ 1 次 save_page）`);
console.log(`    按住键 30 字/秒 ⇒ 30 × 60 = 1800 次/分`);
console.log(`    按住键 15 字/秒 ⇒ 15 × 60 =  900 次/分`);
console.log(`  撤后上传 = min(编辑速率, 1/roundMs)：roundMs=${ROUND_MS} ⇒ 上限 ${Math.round(60000 / ROUND_MS)} 次/分`);
console.log(`  今天（去抖在）：猛打期间**一次都不落库**（尾沿去抖被一直重置）⇒ 停手后 1 次`);

// —— 变体：两层是**可以分开撤**的（撤哪一层，数字完全不同）——
const variants = [
  ["今天（保存 600 ＋ 上传 400）", 600, 400],
  ["只撤保存（保存 0 ＋ 上传 400）", 0, 400],
  ["只撤上传（保存 600 ＋ 上传 0）", 600, 0],
  ["两层都撤（0 ＋ 0）", 0, 0],
  ["中间档：保存 600 ＋ 上传 150", 600, 150],
  ["中间档：保存 600 ＋ 上传 250", 600, 250],
  ["中间档：保存 600 ＋ 上传 100", 600, 100],
  ["中间档：保存 0 ＋ 上传 150（保存去抖已无意义）", 0, 150],
];
console.log(`\n# 变体对照（roundMs = ${ROUND_MS}ms）· 单位：次/分\n`);
console.log("变体".padEnd(34) + "① 一般打字".padStart(14) + "② 快速打字".padStart(14) + "③ 猛打".padStart(14));
for (const [name, s, u] of variants) {
  const cells = [];
  for (const key of Object.keys(models)) {
    const { edits, windowMs } = models[key]();
    const r = simulate(edits, { saveMs: s, uploadMs: u, roundMs: ROUND_MS, windowMs });
    cells.push(`${Math.round(r.saves.length / (windowMs / 60000))}/${Math.round(r.uploads.length / (windowMs / 60000))}`);
  }
  console.log(name.padEnd(34) + cells.map((c) => c.padStart(14)).join(""));
}
console.log("\n（每格 = 落库/分 ÷ 上传/分）");
```

### 8.2 `/tmp/d3/round-cost.mjs`

```js
// DEC-3「先量」· 一轮上传的真实耗时（对**真服务端**，HTTP over loopback）
//
// 量的是 `sync_workspace` 那一轮的两步：`POST /push`（把 outbox 里的页 upsert 推上去）
// ＋ `GET /pull?since=<水位>`（增量拉）。⚠️ **不含**客户端进程内的 SQLite / Tauri IPC。
//
// 用法：node /tmp/d3/round-cost.mjs http://127.0.0.1:8921
const base = process.argv[2] ?? "http://127.0.0.1:8921";
const N = 30;

const uniq = Date.now();
const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`非 JSON（HTTP ${r.status}）：${t.slice(0, 200)}`);
  }
};

const reg = await j(
  await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `d3-${uniq}@test.local`,
      password: "d3-measure-1",
      display: "d3",
    }),
  }),
);
const token = reg.token;
const sp = await j(
  await fetch(`${base}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "d3-cost" }),
  }),
);
const space = sp.id;

/** 仿 `record_page_upsert` 的载荷：整行 PageDetail ＋ `crdt_state`（整块状态，JSON 字节数组）。 */
function payloadFor(chars) {
  const text = "字".repeat(chars);
  const doc = { id: "p-d3", workspace_id: "ws", title: "t", content_json: JSON.stringify({ root: text }), content_text: text };
  const state = chars === 0 ? null : Array.from({ length: chars }, (_, i) => i % 256);
  const out = { ...doc, stamp: { ms: Date.now(), counter: 0, device: "dev-d3" } };
  if (state) out.crdt_state = { v: 1, state };
  return JSON.stringify(out);
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stat = (xs) => ({
  p50: pct(xs, 50).toFixed(1),
  p95: pct(xs, 95).toFixed(1),
  max: Math.max(...xs).toFixed(1),
});

let watermark = 0;
let devSeq = 0;
async function pushOnce(payload) {
  devSeq += 1;
  const t0 = performance.now();
  const r = await j(
    await fetch(`${base}/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        device_id: `dev-d3-${uniq}`,
        space_id: space,
        changes: [
          { device_seq: devSeq, entity: "page", entity_id: "p-d3", op: "upsert", payload, updated_at: Date.now() },
        ],
      }),
    }),
  );
  return { ms: performance.now() - t0, accepted: r.accepted };
}
async function pullOnce() {
  const t0 = performance.now();
  const r = await j(
    await fetch(`${base}/pull?space_id=${space}&since=${watermark}&limit=500`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const ms = performance.now() - t0;
  for (const c of r.changes ?? []) watermark = Math.max(watermark, c.seq ?? 0);
  return ms;
}

console.log(`# DEC-3 一轮上传耗时（真服务端 ${base}，loopback）· N=${N} 每档\n`);
console.log("载荷".padEnd(34) + "字节".padStart(9) + "push p50/p95/max(ms)".padStart(26) + "整轮 p50/p95/max(ms)".padStart(26));
for (const [name, chars] of [
  ["空档：没有 crdt_state（老载荷形状）", 0],
  ["2 000 字页面（state≈2.1KB ⇒ 载荷≈8KB）", 2000],
  ["8 000 字页面（state≈8.1KB ⇒ 载荷≈30KB）", 8000],
]) {
  const payload = payloadFor(chars);
  const bytes = Buffer.byteLength(payload, "utf8");
  for (let i = 0; i < 3; i++) {
    await pushOnce(payload);
    await pullOnce();
  }
  const pushMs = [];
  const roundMs = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const p = await pushOnce(payload);
    await pullOnce();
    const t2 = performance.now();
    pushMs.push(p.ms);
    roundMs.push(t2 - t0);
  }
  const a = stat(pushMs);
  const b = stat(roundMs);
  console.log(
    name.padEnd(34) +
      String(bytes).padStart(9) +
      ` ${a.p50} / ${a.p95} / ${a.max}`.padStart(26) +
      ` ${b.p50} / ${b.p95} / ${b.max}`.padStart(26),
  );
}

// 「无事可推」的一轮（push 被 INSERT OR IGNORE 忽略 ⇒ accepted=0）：撤防抖后**不会**出现，
// 但今天"每次暂停都跑一轮"里，多数轮次其实是这种（没有新改动）。
{
  const payload = payloadFor(2000);
  devSeq += 1; // 先真的推一次
  await pushOnce(payload);
  const dup = devSeq; // 再用同一个 device_seq 推 ⇒ 被忽略
  const ms = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await j(
      await fetch(`${base}/push`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: `dev-d3-${uniq}`,
          space_id: space,
          changes: [
            { device_seq: dup, entity: "page", entity_id: "p-d3", op: "upsert", payload, updated_at: Date.now() },
          ],
        }),
      }),
    );
    await pullOnce();
    ms.push(performance.now() - t0);
  }
  const s = stat(ms);
  console.log("\n无事可推的一轮（accepted=0 ＋ 增量 pull）：p50/p95/max = " + `${s.p50} / ${s.p95} / ${s.max} ms`);
}
console.log(
  `\n⇒ 喂给频率模型：node /tmp/d3/debounce-model.mjs <roundMs>（用上面整轮 p50）`,
);
```

### 8.3 `/tmp/d3/sqlite-write-cost.mjs`

```js
// DEC-3「先量」· 落库那几步的 SQLite 成本（**同引擎近似**）
//
// ⚠️ 这不是产品进程内的实测：产品的 `save_page` 走 **rusqlite（进程内）＋ Tauri IPC**，
//    这里用 **node:sqlite**（同一个 SQLite 引擎、同一批语句、同样的 WAL + synchronous=NORMAL）
//    在一个临时文件库上量。⇒ 它给的是**下界/量级**，不含 IPC、不含 FTS/块图重建。
//
// 量的语句按产品顺序（`src-tauri/src/commands.rs` 的 `save_page`）：
//   ① 快照去重读（`versions::snapshot_before_save` 的 SELECT）
//   ② 插入版本快照（同一个函数的 INSERT）
//   ③ 写页面行（`doc_content::write` 的 UPDATE）
//   ④ 插 outbox 记录（`sync::record_page_upsert` → `record_change` 的 INSERT，payload = 整页 ＋ crdt_state）
//   ⑤ **每次编辑就发生的那一笔**：写 `page_crdt` 状态 BLOB（`Editor.tsx` → `b.persist()` → `save_page_state`）
//
// 用法：node /tmp/d3/sqlite-write-cost.mjs
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

const N = 30;
const dbPath = "/tmp/d3/client-like.db";
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE pages (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
                      content_json TEXT NOT NULL DEFAULT '{}', content_text TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
                        op TEXT NOT NULL, payload TEXT, updated_at INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT '');
  CREATE TABLE page_versions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
                              content_json TEXT NOT NULL DEFAULT '{}', content_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  CREATE INDEX idx_page_versions_page ON page_versions(page_id, created_at DESC);
  CREATE TABLE page_crdt (page_id TEXT PRIMARY KEY, state BLOB NOT NULL, updated_at INTEGER NOT NULL);
`);
db.prepare("INSERT INTO pages (id, workspace_id, title, content_json, content_text, updated_at) VALUES ('p-d3','ws','t','{}','',0)").run();
db.prepare("INSERT INTO page_crdt (page_id, state, updated_at) VALUES ('p-d3', ?, 0)").run(new Uint8Array([1, 2, 3]));

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const row = (label, xs, bytes) =>
  label.padEnd(52) + String(bytes ?? "").padStart(8) + ` ${pct(xs, 50).toFixed(3)} / ${pct(xs, 95).toFixed(3)}`.padStart(22);

console.log(`# DEC-3 落库几步的 SQLite 成本（node:sqlite · WAL · synchronous=NORMAL · 文件库）· N=${N}\n`);
console.log("步骤".padEnd(52) + "字节".padStart(8) + "p50 / p95 (ms)".padStart(22));

for (const chars of [2000, 8000]) {
  const text = "字".repeat(chars);
  const contentJson = JSON.stringify({ root: text });
  const stateBytes = new Uint8Array(chars); // ≈1 字节/字（压测实测：0.5~8k 字 ≈1.0~1.2 B/字）
  for (let i = 0; i < stateBytes.length; i++) stateBytes[i] = i % 256;
  const wirePayload = JSON.stringify({
    id: "p-d3",
    workspace_id: "ws",
    title: "t",
    content_json: contentJson,
    content_text: text,
    crdt_state: { v: 1, state: Array.from(stateBytes) },
    stamp: { ms: 1, counter: 0, device: "dev-d3" },
  });

  // warmup
  for (let i = 0; i < 3; i++) {
    db.prepare("SELECT title, content_json, content_text FROM page_versions WHERE page_id=? ORDER BY created_at DESC LIMIT 1").get("p-d3");
    db.prepare("UPDATE pages SET content_json=?, content_text=?, updated_at=? WHERE id=?").run(contentJson, text, i, "p-d3");
    db.prepare("INSERT INTO changes (entity, entity_id, op, payload, updated_at) VALUES ('page','p-d3','upsert',?,?)").run(wirePayload, i);
    db.prepare("UPDATE page_crdt SET state=?, updated_at=? WHERE page_id=?").run(stateBytes, i, "p-d3");
  }

  const read = [], snap = [], write = [], outbox = [], crdt = [], seqAll = [];
  for (let i = 0; i < N; i++) {
    let t = performance.now();
    db.prepare("SELECT title, content_json, content_text FROM page_versions WHERE page_id=? ORDER BY created_at DESC LIMIT 1").get("p-d3");
    read.push(performance.now() - t);

    t = performance.now();
    db.prepare("INSERT INTO page_versions (id, page_id, title, content_json, content_text, created_at) VALUES (?,?,?,?,?,?)")
      .run(`v-${chars}-${i}`, "p-d3", "t", contentJson, text, i);
    snap.push(performance.now() - t);

    t = performance.now();
    db.prepare("UPDATE pages SET content_json=?, content_text=?, updated_at=? WHERE id=?").run(contentJson, text, i, "p-d3");
    write.push(performance.now() - t);

    t = performance.now();
    db.prepare("INSERT INTO changes (entity, entity_id, op, payload, updated_at) VALUES ('page','p-d3','upsert',?,?)").run(wirePayload, i);
    outbox.push(performance.now() - t);

    t = performance.now();
    db.prepare("UPDATE page_crdt SET state=?, updated_at=? WHERE page_id=?").run(stateBytes, i, "p-d3");
    crdt.push(performance.now() - t);

    // 整条 save_page 形状（②③④ 之和，逐步累加量出来的）
    seqAll.push(snap[i] + write[i] + outbox[i]);
  }
  console.log(`\n—— 页面 ${chars} 字（content_json ${Buffer.byteLength(contentJson)}B ＋ text ${Buffer.byteLength(text)}B ＋ state ${stateBytes.length}B ⇒ 载荷 ${Buffer.byteLength(wirePayload)}B）——`);
  console.log(row("① 快照去重的 SELECT", read));
  console.log(row("② 版本快照 INSERT（整份内容副本）", snap, Buffer.byteLength(contentJson) + Buffer.byteLength(text)));
  console.log(row("③ 页面行 UPDATE", write));
  console.log(row("④ outbox 记录 INSERT（整页载荷）", outbox, Buffer.byteLength(wirePayload)));
  console.log(row("①+②+③+④ ≈ 一次 `save_page` 的 SQLite 那半", seqAll));
  console.log(row("⑤ 每次编辑就写的 page_crdt 状态 BLOB", crdt, stateBytes.length));
}

// —— `doc_content::derive` 里**能照搬的那一半**：FTS5（`search::sync_fts` 的 DELETE + INSERT）——
// ⚠️ `derive` 还有 `blocks::rebuild_block_graph`（JSON 解析 ＋ blocks/backlinks 重建），
//    那部分要 Rust 的解析器，这里**量不了**（如实标出）。
{
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(page_id UNINDEXED, title, body, tokenize='trigram');`);
  console.log("\n—— derive 的 FTS5 那一半（trigram 分词，`sync_fts` 的 DELETE + INSERT）——");
  for (const chars of [2000, 8000]) {
    const text = "字".repeat(chars);
    const del = db.prepare("DELETE FROM page_fts WHERE page_id = ?");
    const ins = db.prepare("INSERT INTO page_fts (page_id, title, body) VALUES (?1, ?2, ?3)");
    for (let i = 0; i < 3; i++) {
      del.run("p-d3");
      ins.run("p-d3", "t", text);
    }
    const xs = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      del.run("p-d3");
      ins.run("p-d3", "t", text);
      xs.push(performance.now() - t);
    }
    console.log(row(`FTS5 重建（正文 ${chars} 字）`, xs, Buffer.byteLength(text)));
  }
}
db.close();
console.log("\n⚠️ 不含：Tauri IPC（每一次 `save_page` 一次）、rusqlite 进程内开销、");
console.log("   `blocks::rebuild_block_graph`（JSON 解析 ＋ blocks/backlinks 重建）、`stamp_block_revs`、`fetch_page`。");
```

---

## 9. 本文的边界（写死在末尾）

```text
· **只量不改**：`src/App.tsx` 的 600/400 与 `Editor.tsx` 的 `persist()` 一个字节没动；
  产品仓与 `_workspace` 也没有任何改动（只有本文这一个新文件）。
· **不是 T3 的方案**："撤了之后用什么给上限（节流？只在内容变了才存？）"是 T3 的设计问题 ——
  本文只把"撤了会变成多少"量出来（含 §5.3 那条方法学结论）。
· 与既有读物的关系：`client-frame-rate-loadtest`（每帧成本、状态体积）、
  `server-capacity-loadtest`（服务端容量）、`owner-decisions-pending` 的 DEC-3、`enterprise-edition-tasks` 的 T3。
```
