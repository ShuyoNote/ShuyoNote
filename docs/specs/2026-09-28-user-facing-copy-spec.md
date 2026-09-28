# 规格：用户可见文案（copy）

> 起草：macOS 侧｜**2026-09-28**｜依据：`_workspace/AI-NATIVE-DEV.md` §5.1（规格层）＋ 本仓 [`docs/specs/README.md`](README.md)
> 同日同层的另一份（面板结构与密度）：[`2026-09-28-sync-panel-density-spec.md`](2026-09-28-sync-panel-density-spec.md)
>
> ⚠️ **本层的第一优先级不是"多一份文档"，是"每条不变式都得有一条会红的判据"。**
> 本文件三条不变式的第四列**全部是 `❌ 无`** ⇒ 按 `README.md` 的铁律，**它们现在还不进 `INVARIANTS.md`**。
> 本文件的作用是把"要立哪条判据、怎么证明它会红"写成**可执行的前置条件**（同密度那份的做法）。

---

## 0. 需求（一句话，本规格只服务它）

> **文案是给用户看的，但生成文案的代码并不知道谁在看。**
> ⇒ 所以"给人看"这件事必须在**边界**上做一次，而不是靠每处调用点各自记得。

**现场（2026-09-28，owner 在真机上看到的三类症状，都已用真 Chromium/真代码复核）**：
1. **内部标识的裸值漏进句子**：`keyring.rs:175` 「这个盒子属于空间「{id}」，不是「{space_id}」（盒子被换过？）」
   —— 让用户**比对两个 UUID**，而他**无法据此做任何动作**。
2. **行内 Markdown 没生效**：`.sync-lan` 渲染出 `…**能被别人拉到**`（来源 `mesh.rs:602`）、
   `.sync-mesh` 渲染出 `…时会**顺手**…`（来源 `SyncPanel.tsx:1273`）—— 星号原样露给用户。
3. **相邻 inline 元素无分隔**：`.sync-mesh` 渲染出「网格（设备之间直接同步）**口令：已设开着** 的空间点…」
   —— 两个 `display:inline` 的 `.sync-hint` 首尾黏在一起（`SyncPanel.tsx:1269` 与 `:1273`）。

---

## 1. 字段口径（与 `INVARIANTS.md` 同形）

```text
id          INV-UI-copy-<短名>      稳定标识；改口径不许改 id（改 id = 删除 + 新增）
口径        一句话；从判据的真源逐字引用，不在此重写
判据        scripts/check-copy-discipline.mjs（**新建**；或挂进现有静态扫描类）
会红证据    ✅ 有（证明命令 + 期望非 0 退出码 + 账本 sha）／❌ 无（⇒ 按 README 铁律，该条还不该进 INVARIANTS.md）
```

**为什么载体要新建一个脚本**（而不是塞进 `verify-mobile-views.mjs`）：
密度那三条要**跑真 Chromium**（它们量的是渲染结果）；而文案这三条是**静态扫描**（扫源码里的字符串与 JSX），
两者**前置条件不同**（一个要 dev server，一个不要）⇒ 混在一起会让"要不要起服务器"变成一个有歧义的开关。
> 仓内先例：静态扫描类判据（`check-hook-order` / `check-store-subscriptions`）都是独立脚本 ＋ `--self-test`，
> 且按本仓 §3 例外，**它们的承重证明在 `--self-test`**（正例 + 负例各一），不进 `criteria-mutations.json`。

---

## 2. 不变式（`❌ 无` ＝ 按 README 铁律，**暂不进 `INVARIANTS.md`**）

| id | 口径（一句话） | 判据（要立的那条） | 会红证据 |
|---|---|---|---|
| **INV-UI-copy-no-internal-ids** | **用户可见的文案里不得插值内部标识符的裸值**（`space_id` / `device_id` / `peer_device` / `seq` / `entity_id` / `run_id` / `attr_id` …）；排障需要时放 `title` 或「复制诊断信息」 | 新建 `scripts/check-copy-discipline.mjs`：扫 `.rs` / `.tsx` 的**用户可见字符串**（形状见 §3），命中即红；内部用途（URL 拼装 / 文件名 / meta key / SQL / 日志）按形状排除 | **❌ 无**（要立。**怎么证明它会红**：`--self-test` 用两个夹具 —— ① `format!("空间「{space_id}」不存在")` ⇒ 必须报；② `format!("{}/push", base)` ⇒ 必须**不**报。<br>⚠️ **现存 10 处候选**已在 §4 逐条列出 ⇒ 用"已知红基线（只减不增）"落进 CI，先例 `check-plan-status` 的 64 处旧账） |
| **INV-UI-copy-inline-markdown** | **后端给的文案是行内 Markdown 写法（`**强调**`），所以它在【进入界面的边界】必须被转成元素**；不许原样露出星号 | ① **边界机制**：把 `inlineMd` 从"调用点约定"升成边界（一个 `<BackendText text={…}/>`，或让文案在 `api.ts` 出口统一过一遍）<br>② **门禁**：扫 `.tsx` 里 JSX 文本节点含字面 `**`、以及 JSX 表达式直插后端字符串而外层没有 `inlineMd`/`BackendText` ⇒ 红 | **❌ 无**（要立。**怎么证明它会红**：夹具 —— ① JSX 文本里写 `时会**顺手**…` ⇒ 必须报（**现状就是红的**，`SyncPanel.tsx:1273`）；② 在 `Toaster.tsx`/`SpacePrivacySection.tsx` 那 9 处**已过 `inlineMd`** 的写法 ⇒ 必须不报） |
| **INV-UI-copy-inline-separators** | **相邻的 `display:inline` 文案元素之间必须有分隔**（分隔符、外边距或改成块级） | 新建判据（可与上一条同一脚本）：扫 `.tsx` 里**两个相邻 inline 文案元素直接相邻**（中间无文本节点/分隔元素）的形状 ⇒ 红 | **❌ 无**（要立。**怎么证明它会红**：夹具 —— ① `SyncPanel.tsx:1269`+`:1273` 那种相邻 `.sync-hint` ⇒ 必须报（**现状 3 处都红**）；② 中间插一个分隔 `·` 的写法 ⇒ 必须不报） |

---

## 3. 判据的**形状**（决定它可不可能不误报 —— 这一节比上面那张表重要）

### 3.1 什么算"用户可见字符串"（`INV-UI-copy-no-internal-ids`）
```text
✅ 算（会红）：  Err(format!("…中文…{xxx_id}…")) ／ format!("…中文…{seq}…")
                JSX 文本节点里插值的 `{xxx.entity_id}` ／ placeholder="…{xxx_id}…"
❌ 不算（豁免）：URL 拼装        format!("{}/push", base)
                文件名 / 临时名  format!("{space_id}.db") ／ format!("shuy_{tag}_{seq}")
                meta key         format!("mesh_cursor:{space_id}:{peer}")
                SQL              "SELECT seq FROM pending_remote_pages WHERE page_id = ?1"
                日志             push_log("host", "info", …)
                注释 / 测试       // / /// / assert! / it(…)
```
⚠️ **这条判据是启发式**（本仓的用户文案是中文，⇒ 用"含中文"当近似）。
   所以它是**候选过滤器**，不是结论 ⇒ **每一条都要人工交代一句"它到底会不会到界面"**。
   这正是"已知红基线"的用法（与 `check-plan-status` 同一形状）。

### 3.2 `INV-UI-copy-inline-markdown` 的方向选择
```text
两条路：
  (A) 让契约生效：把 inlineMd 落到边界 ⇒ **推荐**。契约已经存在、有实现（src/lib/inlineMd.tsx）、有测试
      （src/lib/inlineMd.test.tsx 4 个用例，且它自称"是'用户看不见两个星号'这件事的唯一一处实现"）
  (B) 取消契约：Rust 侧不再写 ** ⇒ 代价大（要改 100+ 处），且 (A) 的实现与测试全白做
⇒ 选 (A)。而 (A) 的**覆盖率**才是问题：实测 **9 处套了 inlineMd ／ 50 处直插后端字符串**（≈15%）。
```
> ⚠️ **契约的唯一书面出处是 `SpacePrivacySection.tsx:253-254` 的一行注释** —— `AGENTS.md` 与 `docs/` 里 `grep` 不到。
> ⇒ 一条"要靠读过那行注释并记得顺手做"的规矩，必然漏。**这就是本条要立判据的理由。**

---

## 4. `INV-UI-copy-no-internal-ids` 的现存候选（**10 处**，逐条交代）

```text
候选（A 类：中文字符串里插值了内部标识）
  src-tauri/src/keyring.rs:175       「这个盒子属于空间「{id}」，不是「{space_id}」（盒子被换过？）」  ← 最糟：让用户比对两个 UUID
  src-tauri/src/keyring.rs:228       「钥匙袋里没有空间「{space_id}」的盒子」
  src-tauri/src/space_crypto.rs:246  「空间「{space_id}」按钥匙袋是加密的，但会话未解锁（请先输口令）」
  src-tauri/src/space_crypto.rs:387  「空间「{space_id}」不存在」
  src-tauri/src/space_crypto.rs:631  「钥匙袋里没有空间「{space_id}」的盒子」
  src-tauri/src/db.rs:171            「空间 {space_id} 的库」
  src-tauri/src/security.rs:622      「空间 {space_id} 的库」
  src-tauri/src/backup.rs:540        「恢复加密空间 {orig_id} 需要先解锁: {e}」
  src-tauri/src/plugins.rs:1975      「给页面 {target} 设置属性 {attr_id} = {value}」
  src-tauri/src/plugins.rs:2400      「取消 run {run_id}：它已经结束了」

前端候选（1 处，且**可及性未核**）
  src/components/SyncPanel.tsx:1449  {it.title || it.entity_id.slice(0, 10)}
                                     ⇒ 条目拿不到标题时，条目名**回落成裸 id 前 10 位**
```
**对照（B 类 75 处，不该动）**：URL 拼装 / 文件名 / meta key / SQL / 日志 —— 它们不是"给人看的"。

**替代写法（本规格建议的口径）**：
```text
用【用户认得的名字】：空间名 / 设备名 / 页面标题
名字拿不到时用【相对描述】：「这个空间」/「第 2 个空间」——**不要回落成 id**
id 转去日志或 title（排障用）
例：keyring.rs:175 ⇒ 「这个空间的钥匙盒对不上（可能被别的空间覆盖过）」
```

---

## 5. 落地顺序（**先让判据可跑，再进 `INVARIANTS.md`**）

```text
第 1 步  写 scripts/check-copy-discipline.mjs ＋ --self-test（每条至少一正一负夹具）
         ⇒ 这是三条共用的一件事：载体先有，才有"看过它红"
第 2 步  用【已知红基线】把现状落进 CI（只减不增）
         · no-internal-ids ：10 处候选（§4）
         · inline-markdown ：SyncPanel.tsx:1273 等（星号）
         · inline-separators：SyncPanel.tsx:1269↔:1273 等 3 处
         ⇒ 先例逐字（scripts/check-plan-status.mjs:44）：
            「之所以要有基线：上线当天就有 64 处旧账。**没有基线，门禁第一天就得被绕开或被删」**
第 3 步  改文案（10 处逐个交代 + 星号那两处 + 分隔那三处）⇒ 基线只减不增，自动收紧
第 4 步  三条都拿到"看过它红"的证据（`_self-test` 夹具 ＋ 账本 sha）⇒ 才搬进 INVARIANTS.md
```

---

## 6. 与其它文档的分工（防止互相抄）

| 文件 | 放什么 | 不放什么 |
|---|---|---|
| `docs/plans/2026-09-27-sync-panel-mobile-density.md` | **过程**：面板的 F1–F12 勘察读数、四个选项 | 文案口径 |
| `2026-09-28-sync-panel-density-{requirements,spec}.md` | **面板结构与密度**（壳维、常驻 chrome、滚动） | 文案里该不该出现标识符 |
| **本文件** | **用户可见文案**：标识符 / 行内 Markdown / 相邻分隔 | 面板布局与高度 |

---

## 7. 本文件**故意不含**的

- ❌ **具体文案的最终措辞**（那是逐条改的事；本文件只给"能用什么、不能用什么"的口径）。
- ❌ **`ollama pull` 那类"要让用户照着敲的命令"** —— 它**合法**（用户能拿它行动），本条只挡**不可执行**的标识符。
- ❌ **把 `title`/tooltip 里的 id 也挡掉** —— 排障需要它，且它不占视觉。
