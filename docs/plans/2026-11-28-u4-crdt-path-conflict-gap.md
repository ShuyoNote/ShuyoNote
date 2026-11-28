# U4 缺口：CRDT 快捷路径上的「同块双改」是**静默 LWW**（内容级路径才是可见/可裁决的）

状态：待做（已知缺口，2.1.17 发布说明中标"部分验证"）
证据：`_workspace/notes/2026-11-26-u4-precheck-empty-crdt-clobbers-content.md` §11；本文件 §2 的真机读数

## 1. 现象（2026-11-28 真机，U4-FINAL）

```text
基线：两边第 2 行 = 「A-最终」（content 1051 / 1052，血统已同源）
B 先改：第 2 行 → 「B-最终-2」（content 1050，seq=423，11:25:40）
A 后改：第 2 行 → 「A-最终-2」（content 1053，seq=779）⇒ 点「立即同步」+ 重开页面
结果：**page_conflicts = 0**；页面变成 B 的版本（「B-最终-2-2」）；A 随后把它写回（seq=794）
⇒ A 的改动**被静默覆盖**，没有冲突条、没有可裁决对象。
```

对比（同一天的 PAIR-TEST-4）：那次**弹了**块级冲突条、`page_conflicts` 落了行、留本地可核 —— 走的是**内容级**路径。

## 2. 原因（两条合并路径口径不一致）

```text
路径① 内容级：`docContent.applyRemoteContent` → `mergeRemoteContent`
        · 按块 rev 比较：等 rev 不同内容 ⇒ `conflicted` ⇒ `recordPageConflicts` + 界面弹条 ✓
路径② CRDT 会话：`pageBinding.bindPageToEditorViaPort` → `session.merge(p.state)`
        · Yjs 直接合并 ⇒ **后写胜**，不落 `page_conflicts`、不弹条 ✗
        并且合并结果会被随后写回内容列（`save`）⇒ 内容级路径再比较时两边已经一样了。
```

## 3. 为什么不能"顺手补一个判断"

```text
界面侧（TS）**没有写 `page_conflicts` 的接口**：`api` 只有 `listPageConflicts` / `resolvePageConflict`；
写入在 `docContent.recordPageConflicts`（要 db 句柄，界面侧没有）。
若用"投影不同就报冲突"的粗暴判据 ⇒ **正常同步**（本地只是旧了）也会报 ⇒ 每次同步弹条，比现状更糟。
⇒ 必须带"基线"信息（块 rev / 共同祖先）才判得准，属于**设计级**改动。
```

## 4. 落地步骤（下一步聚焦任务，约 60–90 分钟）

```text
① Rust 新增命令 `record_page_conflicts(pageId, conflicts[])`（复用 `doc_content` 的插入逻辑，
   与 `record_lineage_conflict` 同一形态），并在 `src/lib/platform/commands.ts` 登记
② `api.recordPageConflicts` 包装；端口新增 `recordBlockConflicts?`；`Editor.tsx` 接上
③ `bindPageToEditorViaPort`：合并**前**用 `mergeRemoteContent(本机投影, 待并投影)` 判 conflicted
     · conflicted ⇒ 记行 + **不合并**（`deferred += 1`，把待并项留下）+ 不写投影
     · merged/其它 ⇒ 照旧 `session.merge`
④ 判据（先写判据再改代码）：
     a) 等 rev 不同内容 ⇒ 记一行、pendingDeferred=1、页面正文**保持本地**
     b) rev 不同（远端更新）⇒ 不记行、正常合并（**不许误报**）
     c) 无 rev 信息 ⇒ 与今天一致（不记行）
     d) 记行后用户「留本地/用远端」⇒ resolved_choice 有值（复用现有裁决 UI）
```

## 5. 2.1.17 的处理

```text
U4 标「**部分验证**」：
  · 内容级路径：有实测（PAIR-TEST-4：检测 → 弹条 → 定位/留本地/用远端 → resolved_choice=local → 传播）
  · CRDT 快捷路径：**未覆盖**（本文件）
发布说明里如实写这一条（"两台同时改同一段时，若走 CRDT 快捷合并，可能静默采用较新的一版"）。
```
