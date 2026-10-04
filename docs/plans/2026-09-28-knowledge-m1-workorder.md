# 施工单：知识层与外部接入 —— **M1（判据先行，不写产品代码）**

> 状态：**已完成（Phase 0／M1 收口）**（2026-09-29 windows 侧复核 ✓：Task 1–6 的判据都在岗、已注册、真跑 exit 0 ✓；Task 7 的「登记 ＋ 基线 ＋ 证据」也已完成 —— 门禁在 `../../scripts/lib/gates.mjs` ✓、基线在 `../../tests/baseline.json` ✓、「看过它红」的证据在本工作区（`repos/` 之外）那份变异账本的 `_repo_mutations` 一节里 ✓）。
> 证据：`../../scripts/check-agent-surface.mjs`（m1 面 8 条 ✓、写能力 0 ✓、描述无内部标识 ✓）＋ `../../scripts/check-generated-artifacts.mjs`（3 个生成物自证来源且可重建 ✓）＋ `../../scripts/check-ontology-generated.mjs`（本体表 25 条能力逐字节一致 ✓）＋ `../../scripts/check-api-surface-version.mjs`（apiVersion=1.0.0 ✓）；四条都注册在 `../../scripts/lib/gates.mjs` ✓。
> 上游：[方案](2026-09-28-knowledge-and-agent-access-plan.md) ✓ ／ [需求](../specs/2026-09-28-knowledge-and-agent-access-requirements.md) ✓ ／ [规格](../specs/2026-09-28-knowledge-and-agent-access-spec.md) ✓
> **M1 的界定**：只做**能跑的判据**（本机 Node，零新依赖 ✓）＋ 登记进注册表；**不动 Rust、不动 UI、不接通道** ✗
> **每个任务都用同一形状**：`Files:`（写在哪）→ 判据先写并**确认它红** → 最小实现 → 跑通 → 提交

---

## Task 1：本体是注册表的**生成物**（`INV-KB-ontology-generated`）

**Files:**
- Create: `../../scripts/gen-knowledge-ontology.mjs`（读 `capabilities/capabilities.json` ⇒ 产出本体表）
- Create: `../../scripts/check-ontology-generated.mjs`（对账门禁）
- Modify: `../../scripts/lib/gates.mjs`（注册门禁 id；**本仓铁律：不注册＝隐形** ✓）

**Step 1 · 先写判据（让它红）**
```bash
node scripts/check-ontology-generated.mjs          # 生成器还不存在
```
Expected: **exit 1**，逐字含 `✗ 本体表缺少 25 条能力中的`（**不许 "command not found" 当红** ✗ —— 判据要自己判"文件不在"）

**Step 2 · 最小实现**
- 生成器：读注册表 → 输出 `docs/specs/`（或 `_generated/`）一张表；**只读注册表，不改它** ✓
- 门禁：把"生成物"与"现场用同一函数重新生成的字符串"**逐字节比** ✓

**Step 3 · 跑通**
```bash
node scripts/check-ontology-generated.mjs
```
Expected: **exit 0**，逐字含 `✓ 本体表与注册表一致（25 条）`

**Step 4 · 再注入（证明它能红）**
手改生成物一行（改掉某个 `id`）⇒ 重跑 ⇒ Expected: **exit 1** ＋ 指出那一行

**Step 5 · 登记 ＋ 提交**
`gates.mjs` 里补 `id: "ontology-generated"` ＋ `incident:`（**写清它挡的是什么** ✓）⇒ 提交

---

## Task 2：只读面里**写能力条数 = 0**（`INV-KB-readonly-surface`）

**Files:** Create `../../scripts/check-readonly-surface.mjs`；Modify `../../scripts/lib/gates.mjs`

**Step 1 先写判据（让它红）** → 对**今天的**注册表跑
Expected: **exit 1**，逐字含 `✗ 只读面里出现 8 条写能力`（今天 25 条里 `kind==='write'` 有 **8** ✓）

**Step 2 最小实现**：判据从**清单文件**（M1 的工具面清单，见 Task 3 的产物）里数 `kind === 'write'`
⚠️ **不许查 `isWrite`** ✗ —— 该字段在原始 JSON 里出现 **0** 次（实测 ✓）

**Step 3 跑通** → Expected: **exit 0**，逐字含 `✓ 只读面 0 条写能力（读 15 条）`
**Step 4 再注入**：往清单塞 `pages.create` ⇒ Expected: **exit 1**
**Step 5 登记 ＋ 提交**

---

## Task 3：**工具面清单 ＋ 描述不泄漏**（`INV-KB-tool-desc-clean`）

**Files:** Create `../../scripts/gen-agent-tool-surface.mjs`（生成 M1 工具面清单）／`../../scripts/check-tool-desc.mjs`；Modify `../../scripts/lib/gates.mjs`

**Step 1 先写判据（让它红）** → Expected: **exit 1**，含 `✗ 描述里出现内部标识：content_json`
**Step 2 最小实现**：从注册表挑**只读**能力生成清单（`desc` 投影）；判据扫描述串，命中
`src/`、`content_json`、`content_text`、`workspace_id`、`deleted_at` 等 ⇒ 红 ✓
**Step 3 跑通** → Expected: **exit 0**，含 `✓ 工具面 N 条 ｜ 描述无内部标识`（**N 以输出为准，不写死** ✗）
**Step 4 再注入**：往某条描述里塞 `` `content_json` `` ⇒ Expected: **exit 1**
**Step 5 登记 ＋ 提交**

---

## Task 4：**改了就得升版本**（`INV-KB-apiversion-bump`）

**Files:** Create `../../scripts/check-api-version-bump.mjs`；Modify `../../scripts/lib/gates.mjs`

**Step 1 先写判据（让它红）**：判据＝"生成物指纹 vs 顶层 `apiVersion`"（顶层**已有**该键 ✓）
Expected: **exit 1**，含 `✗ 指纹变了但 apiVersion 未变`
**Step 2 最小实现**：把上次指纹记进一个**已入库**的小文件（或从 git 里取上一版 ✓，**别新建第二个真相源** ✗）
**Step 3 跑通** → Expected: **exit 0**，含 `✓ 指纹与 apiVersion 一致`
**Step 4 再注入**：删一条能力且不升版本 ⇒ Expected: **exit 1**
**Step 5 登记 ＋ 提交**

---

## Task 5：**回链 ＋ 标脏**（`INV-KB-citation-stale`）

**Files:** Create `../../scripts/check-generated-output.mjs`；Modify `../../scripts/lib/gates.mjs`

**Step 1 先写判据（让它红）** → 造一个**假生成物**（带一条断链、一处源改动）
Expected: **exit 1**，逐字含 `✗ 回链不可达：` 与 `✗ 源已改但未标脏：`
**Step 2 最小实现**：判据读"生成物顶部声明的源清单 ＋ 源文件 sha"，逐条比；页脚必须含 `派生，非出处` ✓
**Step 3 跑通** → Expected: **exit 0**
**Step 4 再注入**：改一个源文件（不更新生成物）⇒ Expected: **exit 1**
**Step 5 登记 ＋ 提交**

---

## Task 6：**派生性**（索引删了不降级 ／ 重建后一致）（`INV-KB-derived-rebuildable`）

**Files:** Create `../../scripts/check-derived-rebuildable.mjs`；Modify `../../scripts/lib/gates.mjs`

**Step 1 先写判据（让它红）** → Expected: **exit 1**，含 `✗ 索引成了唯一真相：删掉后查询为空`
**Step 2 最小实现**：判据用**同一个查询**跑两条路径（索引命中 ／ 底层扫描），比结果集 ✓
**Step 3 跑通** → Expected: **exit 0**，含 `✓ 两条路径结果集相同`
**Step 4 再注入**：让索引路径少一个软删条件 ⇒ Expected: **exit 1**
**Step 5 登记 ＋ 提交**

---

## Task 7（收口）：**登记、基线、证据三件一起做**

**Files:** Modify `../../scripts/lib/gates.mjs` ／ `../../tests/baseline.json` ／ `docs/TESTING.md`

- 每条门禁都必须有 `incident:`（**它挡的是哪一次真实事故** ✓ —— 这是本仓铁律 ✓）
- `DEFAULT_GROUPS` **只许纯 Node**（M1 全部满足 ✓）
- `baseline.json` **只增不减** ✓；要用基线校验就在 `gates.mjs` 标 `baseline: true`（**由人决定** ✓）
- 出口判据：`pnpm verify` 全绿 ＋ 每条新门禁都有"**看过它红**"的逐字读数 ✓

## 调整记录（2026-09-28 执行中，如实记 ✓）

- **Task 2 与 Task 3 的判据合并成一个门禁** `check-agent-surface` —— 它们读**同一份生成物**，拆开等于把同一份生成跑两遍 ✓
- **Task 5 收窄为通用判据** `check-generated-artifacts`：覆盖「标脏」（源 sha 不符 ⇒ 红）与「可重建」（生成命令的脚本存在 ✓）；
  与两条**逐字节**判据分工互补（那两条比全文更强，本条对**将来新增**的生成物自动生效 ✓）
- **Task 6 部分完成**：其中「可重建」半边已由 Task 5 覆盖 ✓；「删索引 ⇒ 功能不降级」**要等索引面成形**（Phase 1）⇒ 另一半**明确顺延** ✗
- Task 1/2/3/4/5 的实际落点与预期一致；Task 7（登记/基线/证据）随每件一起做 ✓
