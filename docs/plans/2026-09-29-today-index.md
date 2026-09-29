# 2026-09-29 一天的产出索引

> 一天里新增/大改了 **30 份文档**（≈6600 行）＋ **24 笔提交**。这份文件是**索引入口** ——
> 想找"某件事的结论在哪"，从这里进，别到处翻。
> ⚠️ **本文件只索引，不重述**（重述会造第二份真相）。

---

## 一、按主题找

### 🟢 主题一 · 附近设备 / 设备直连（**今天的主线**）
| 文件 | 行 | 是什么 |
|---|---|---|
| `docs/specs/2026-09-29-nearby-devices-requirements.md` | 418 | **需求**（小明/小王场景、验收、本轮不做） |
| `docs/specs/2026-09-29-nearby-devices-spec.md` | **997** | **规格**（五条不变式 ＋ 数据形状 ＋ 协议 ＋ **§9–§13 裁定与新专题**）<br>⚠️ **本文件有两半，先看它的 📑 目录** |
| `docs/specs/2026-09-29-nearby-devices-approach.md` | 216 | **方案**（A–E 五片 ＋ 承重判据 ＋ 光标 F1–F5） |
| `docs/specs/2026-09-29-nearby-devices-tasks.md` | 202 | **任务**（T0–T7 ＋ 依赖图 ＋ 写域表） |
> ⭐ **规格 §13（10 个子节）是今天最"重"的产出** —— 它把"设备直连"从"一个开关"变成了
> "**两种情况 ＋ 授权模型 ＋ 三个技术前提 ＋ 一条一句话判据**"。**先读 §13.10 那句判据**。

### 🔵 主题二 · 正文实时（服务器档的上传侧）
| 文件 | 行 | 是什么 |
|---|---|---|
| `docs/specs/2026-09-29-realtime-body-requirements.md` | 445 | **需求**（含 **§9 两半拆解**：下载侧已实时、上传侧缺一条线） |
| `docs/specs/2026-09-29-realtime-body-spec.md` | 325 | 规格 |
| `docs/specs/2026-09-29-realtime-body-approach.md` | 200 | 方案 |
| `docs/specs/2026-09-29-realtime-body-tasks.md` | 228 | 任务 |
> ⚠️ spec/approach/tasks 三份**写于需求 §9 之前**，已加"作废"标注但**本体仍是旧框架** ⇒ 待对齐。

### 🟣 主题三 · 虚拟局域网（进阶路径）
| 文件 | 行 | 是什么 |
|---|---|---|
| `docs/plans/2026-09-29-virtual-lan-option.md` | 187 | **分析**（三个好消息 ＋ 两处代价 ＋ owner 两条裁定） |
| `docs/specs/2026-09-29-virtual-lan-requirements-spec.md` | 210 | **需求＋规格**（五条不变式 ＋ 面板三处 ＋ **owner 重申"服务器不提供个人版"的连带后果**） |
> ⚠️ **方案＋任务未出**（属欠账）。

### 🟡 主题四 · 容量与规模（**今天的实测**）
| 文件 | 行 | 是什么 |
|---|---|---|
| `docs/plans/2026-09-29-server-capacity-loadtest.md` | 277 | **服务端容量压测**（M1≈10／M2≈**100**／M3≈200 台；M2→M3 实测 **9.92 倍**）<br>＋ 附二「加服务器能不能解」＋ 附三「提高单空间上限的路线」 |
| `docs/plans/2026-09-29-client-frame-rate-loadtest.md` | 285 | **客户端喂帧压测**（**~500 条 update/秒**，天花板 ≈900）<br>＋ 一条**决定性口径更正**（每笔一帧 vs 按写批帧） |
| `docs/plans/2026-09-29-single-space-limit-three-routes.md` | 200 | 三条路线对比（**结论与直觉相反**：换存储帮助最小） |
| `docs/plans/2026-09-29-l4-forward-deltas-deep-dive.md` | 148 | **L4 深度**（三条决定性事实 ＋ "丢帧=丢数据"这个新风险） |
| `docs/plans/2026-09-29-payload-increment-deep-dive.md` | 124 | **增量深度**（三条线的共同前提；**不需要算 diff**） |
| `docs/plans/2026-09-29-ten-thousand-scale.md` | 125 | 如何到 10000 台（**按页订阅才降阶** ＋ E2E 元数据边界） |
| `docs/plans/2026-09-29-10000-with-wps-experience.md` | 204 | 10000 台 ＋ WPS 手感（四笔账 ＋ 要 owner 拍的四件 ＋ **团队空间订正**） |

### 🔴 主题五 · 台账（发现与盘点）
| 文件 | 行 | 是什么 |
|---|---|---|
| `docs/specs/2026-09-29-spec-layer-review-findings.md` | 119 | **规格层复查**（近三天 19 份的 **9🔴/11🟡/6🔵**）⇒ 修一条划一条 |
| `docs/plans/2026-09-29-server-sync-redundancy-inventory.md` | 150 | **冗余代码盘点**（「个人版+服务器同步」已废那条路的 A/B/C/D 四张清单 ＋ 防误删的 C 表） |

---

## 二、按"我想知道什么"找（问题 → 去哪）
| 我想知道 | 去哪 |
|---|---|
| 设备直连到底有几种情况？ | `nearby-devices-spec` **§13.1** |
| "配对一次永远可用"是真的吗？ | 同上 **§13.2／§13.3**（＋ **§13.9** 三个技术前提） |
| 为什么多人不能用设备直连？ | 同上 **§13.4**（＋ **§13.10.3** 更深的根） |
| 怎么知道是不是我的设备？ | 同上 **§13.8** |
| 小明同步给小王用哪个空间？ | 同上 **§13.10**（⭐ 一句话判据在 §13.10.5） |
| 一个空间能扛多少台？ | `server-capacity-loadtest` |
| 客户端一秒能吃多少帧？ | `client-frame-rate-loadtest` |
| 怎么到 10000 台？ | `ten-thousand-scale`（＋ `10000-with-wps-experience`） |
| 能像腾讯文档那样吗？ | `10000-with-wps-experience`（＋ `l4-forward-deltas-deep-dive`） |
| 哪些代码可以删？ | `server-sync-redundancy-inventory`（★ 先看 **C 表**） |
| 近三天文档有什么问题？ | `spec-layer-review-findings` |
| 虚拟局域网要不要装 VPN？ | `virtual-lan-option`（＋ 其需求规格 §2-① 三个好消息） |

---

## 三、今天提交（24 笔，代码与文档混合）
```text
feat  ：daac8e1e 设备直连开关+间隔+附近设备+邀请 ｜ b354ac5f 折叠 ｜ dfa79e1a 正文上传侧触发
        9503c0f7 开机读一次 ｜ d021948c 间隔 5 分钟→5 秒 ｜ 851c1a7b 删 keyring 那条路（−758 行）
fix   ：036c826c 措辞订正 ｜ a5c0f614 四件小事（scroll-reachable 进仓等）｜ 02c2e4c3 改词
        3ee4e531 规格改名+注释 ｜ 04c0e264 口径正文统一 ｜ f53a4ea3 监听地址指引
docs  ：c0b87d89 复查台账 ｜ 841d2f3d 容量压测 ｜ 368c1d21 补两节 ｜ 154dc8f9+5653b211 帧率压测
        3f40a2aa 重钉 146 条引用 ｜ 75feaefc 三条路线 ｜ 5548aa3a L4 ｜ 1612b86e 增量
        c0dc4231 10000 ｜ cfabee05 10000+WPS ｜ 669cb6d2 团队空间订正 ｜ f8cf3b53+45f22897 虚拟局域网
        0e4efec3 虚拟局域网需求规格 ｜ f7dde0db 冗余盘点 ｜ b5e8a5b1/0b5481ab/baa5e172/b281937a 规格 §13
        8ffb96d0 规格目录
```

## 四、⚠️ 未决（等你拍）
```text
① **B-1**：闸门在设备直连的邀请路上 —— 按"保留 ＋ 改文案（请用团队空间）"落定？（规格 §13.5 已给依据）
② **单人多设备的"配对进设备直连"** 要不要立需求？（零件 `pairing_*` 已有）
③ **vitest 基线**：删了 2 条 `it()` ⇒ 读数 −2；要不要跑 `pnpm verify:baseline`？
④ **"不过服务器也要多人协作"** ⇒ 新需求，绕不开"成员名单从哪来"（规格 §13.10.8）
```

## 五、⚠️ 已知欠账（不是未决，是要做）
```text
· `realtime-body` 的 spec/approach/tasks **本体仍是旧框架**（只有需求 §9 是新的）⇒ 待对齐
· `nearby-devices-spec` 的**不变式散在四处**（§2／§11／§13.6／§13.8.6）⇒ 待收拢（做法已写在它的目录里）
· **虚拟局域网的方案＋任务未出**
· **删 keyring 后的文档过时**：`sync-server-data-boundary.md:66/:85`、`README.md:159/314-316`、
  `docs/TESTING.md:265-283` ＋ 6 篇 plans ⇒ 待统一
· `mesh::` 有一次**偶发失败**（连跑 3 次 24/0）⇒ 未定位
· **§13.10 那条判据的落地方案＋任务**未出
```

---

## 六、⭐ 追加批次（2026-09-29 深夜 —— 上面那份写完之后又出的一批）

> ⚠️ 上面 §一–§五 写于当日较早；之后又出了 **20 份**。这里**只列新增**，不重述。

### 6.1 两版需求落地（**本轮的主线**）
| 文件 | 是什么 |
|---|---|
| `docs/specs/2026-09-29-enterprise-edition-requirements.md` | **企业版需求（定死）**：MUST 分组 ＋ WON'T ＋ 四条不变式 ＋ 五阶段<br>＋ **§1.1bis**（三个性能指标不在同一个 N 上） |
| `docs/specs/2026-09-29-personal-edition-requirements.md` | **个人版需求（定死）**：13 条 MUST ＋ WON'T ＋ 七条不变式 |
| `docs/plans/2026-09-29-requirements-judgment-matrix.md` | **39 条 MUST 逐条"怎么验"** |
| `docs/plans/2026-09-29-both-editions-difficulty-and-cost.md` | 技术难度与实现成本（人日估算 ＋ 风险） |
| `docs/plans/2026-09-29-both-editions-iteration-plan.md` | **7 个迭代** |
| `docs/specs/2026-09-29-personal-edition-{spec,approach,tasks}.md` | 个人版**规格／方案／任务**（514／310／270 行） |
| `docs/specs/2026-09-29-enterprise-edition-{spec,approach,tasks}.md` | 企业版**规格／方案／任务**（418／222／299 行） |

### 6.2 对标竞品（✅ **已去重整理完毕**，2026-09-29 深夜）
> ⚠️ **整理结论（`620ba7c8`）**：**以最新两份为正文**，被取代的**保留并置顶标注**（**不删文件**）。
```text
**正文（留）**
  · `strongest-enterprise-benchmark` —— 企业/团队目标态**唯一正文**（22 格）
    ＋ **新增 §8**（现状→目标差距与优先级）／**§9**（同类对标视角与独有维度）
    ⚠️ 而 **§0–§7 的编号与 22 格口径一律不变**（判据矩阵逐处引用）
  · `personal-edition-vs-competitors` —— 个人目标态正文（并订正了一处计数错：六格 → 七格）
  · `sync-server-vs-competitors` —— 整体**现状**对标 ＋ 独有 §9 教训
  · `edition-boundary` —— 答「**线为什么画在这里**」（10 处引用）
  · `team-edition-capability-and-limits` —— 「**有什么 ＋ 实测极限**」（13 处引用）
      ⚠️ 这两份**不算冗余**（一个"依据"、一个"清单与数字"）
**被取代（保留 ＋ 置顶标注"已被 X 取代"）**
  · `target-benchmark-vs-competitors` ⇒ 独有内容搬进 strongest §8
  · `team-edition-vs-competitors` ⇒ 独有维度搬进 strongest §9
```
> ⇒ 本节的**那一行"整理者在处理"已经作废**（它是当时的悬空标记）。
`sync-server-vs-competitors`（＋ §9 订正）／`target-benchmark-vs-competitors`／
`team-edition-vs-competitors`／`strongest-enterprise-benchmark`／`personal-edition-vs-competitors`／
`edition-boundary`／`team-edition-capability-and-limits`

### 6.3 规模与性能（**实质依据 —— 需求引用它们，别当冗余删**）
`wps-scale-roadmap`／`l4-page-subscription-limits`／`horizontal-scale-limit-single-space`／
`read-concurrency-limit`

### 6.4 台账与纪律（本轮还债产出）
| 文件 | 是什么 |
|---|---|
| `docs/plans/2026-09-29-owner-decisions-pending.md` | ⭐ **待 owner 拍板清单（唯一）**：D1–D8，每条写清"卡住谁" |
| `docs/plans/2026-09-29-git-operation-discipline.md` | **git 操作纪律**：从今天**四次失误**收出六条规则（含可查信号） |
| `docs/plans/2026-09-29-mesh-flake-diagnosis.md` | ⭐ **`mesh::` 的"偶发失败"＝ 40%**（推翻台账描述） |
| `docs/plans/2026-09-29-inv-ns-second-person-landing.md` | `INV-NS-second-person-implies-team` 的落地方案（**落不了技术拦截**） |
| `docs/plans/2026-09-29-knowledge-mcp-vs-edition-requirements.md` | 知识库/Agent/MCP 那一族 vs 两版需求（**不冲突，同一个轴**） |

### 6.5 ⚠️ 而这一批带来的**两条新纪律**（都值得记住）
```text
① **"连跑 N 次全绿"在 N 小时不构成"它不红"的证据**
   —— 40% 失败率下，3 次全绿的概率有 **22%**（`mesh-flake-diagnosis`）
② **"禁用词"不能机械扫** —— 要区分【提到该动作】与【引用该动作作为依赖】
   —— 前者可能是裁定本身（如 WON'T「不做邀请」），后者才是失效的引用
```
