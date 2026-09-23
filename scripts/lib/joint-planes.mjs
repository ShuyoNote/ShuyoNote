// 三平面**联合验收**（国密 × 全库 AI 覆盖 × 块级 CRDT）—— 「一起测」这件事的**单一事实来源**。
//
// ## 为什么需要这一层
// 三条线各自都有常开门禁，而且各自都是绿的。但**两两/三三相交的格子没有任何人负责**，
// 而那些格子恰好是最贵的一类：三个平面的数据**住在同一张空间库里、走同一条写路径、
// 还要一起过加密 / 备份 / 同步 / 全库扫描**。分开绿 ≠ 一起绿 —— 本仓最爱的例子就是
// 发版链那次「只清 dev profile ⇒ 包表面全对而库级不是国密」：每一步单看都没错，错在交界处。
//
// ## 三态（沿用 `check-release-state.mjs --deep` 与 `check-gm-wired.mjs` 的既有口径）
//   · **就绪**：本机可查的探针**全部**命中 ⇒ 这一平面具备联合验收条件；
//   · **未就绪**：有本机探针不命中 ⇒ 明确点名还缺哪一件（**不是红**，是「还没到」）；
//   · **未实查**：需要外部机器/真机/真模型的读数（标 `external: true`）——
//     它**不参与**本机就绪判定（否则本机永远「未就绪」），但联合验收**开跑前**必须有着落，
//     所以它在 `--plan` 里单列一栏，并由 `JOINT_CELLS` 里对应的格子兜住。
//
// ## 谁执行
//   `scripts/joint-acceptance.mjs`（跑）＋ `scripts/lib/joint-planes.test.mjs`（钉不变量）。
//   后者包含一条**反腐烂**断言：`docs/JOINT-ACCEPTANCE.md` 里那张机器事实块必须与本文件
//   **逐字一致**（与 `check-doc-facts.mjs` 同一手法）⇒ 计划写在文档里、代码动了文档没动时，
//   默认门禁会当场红，而不是等联合验收那天才发现计划是旧的。

/** 本文件里所有 `probe.kind` 的取值 —— 加了新 kind 必须同时给 `evaluateProbe` 一个分支。 */
export const PROBE_KINDS = ["path", "grep", "cmd", "prefix", "manual"];

// ---------------------------------------------------------------------------
// 平面 1：国密
// ---------------------------------------------------------------------------
const SM = {
  id: "sm",
  title: "国密（库级 SM4 页 ＋ 国密参数 / 应用层 v2）",
  why:
    "另两个平面的数据都落在**空间库的磁盘字节**上，而那一层归它：库级页加密（SM4）、库级 MAC/KDF、" +
    "以及应用层的 v2 容器。它单独绿只说明「这份构建是国密的」，不说明「国密构建下另两个平面还成立」。",
  probes: [
    {
      id: "sm.patch-file",
      label: "国密补丁在位（库级那一半的唯一来源）",
      kind: "path",
      target: "patches/0001-sqlcipher-sm3-provider.patch",
    },
    {
      id: "sm.feature",
      label: "`sm-library` 特性在 Cargo.toml 里（库级接线的入口）",
      kind: "grep",
      file: "src-tauri/Cargo.toml",
      pattern: "sm-library",
    },
    {
      id: "sm.cross-backend-fixtures",
      label: "两份跨后端页加密夹具（AES 页 / SM4 页 ＋ 异或判据）",
      kind: "path",
      target: "src-tauri/tests/sqlcipher-sm4-page-fixture.db",
    },
    {
      id: "sm.prefix",
      label: "本机拿得到一份**可链接**的 SM 版 OpenSSL 前缀（Tongsuo）",
      kind: "prefix",
      why:
        "库级国密必须链 SM 版 OpenSSL；拿不到 ⇒ 门禁会**自报跳过**，而「自报跳过 ≠ 绿」、" +
        "所以联合验收要求它**不跳过**（跳过时这一格算未就绪）。",
    },
    {
      id: "sm.wired-gate",
      label: "库级接线门禁在岗（跑全量 lib 单测）",
      kind: "path",
      target: "scripts/check-gm-wired.mjs",
    },
    {
      id: "sm.static-prefix",
      label: "静态前缀（`--require-static`）读数 —— Windows 侧静态链接那一支",
      kind: "manual",
      external: true,
      how: "Windows/AMD：`vcpkg install openssl:x64-windows-static-md` 或本地静态 Tongsuo，然后 `sm-library-build.mjs --prepare --require-static`",
    },
  ],
  readings: [
    {
      label: "库级接线：打补丁 ＋ `--features sm-library` 下**全量 lib 单测**",
      cmd: "node scripts/check-gm-wired.mjs",
      owners: ["macos", "windows"],
      criterion: "内部下限：`failed == 0 且 passed ≥ 380`（空跑即红）；跑完自己还原补丁并重建默认特性",
    },
    {
      label: "发布链断言（后端 ＋ 补丁 ＋ 页加密 ＋ sm-crypto ＋ 前缀目录）",
      cmd: "SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl SHUYONOTE_EXPECT_SM_PATCH=applied SHUYONOTE_EXPECT_PAGE_CIPHER=sm4 SHUYONOTE_EXPECT_SM_CRYPTO=on node scripts/check-crypto-backend.mjs",
      owners: ["macos", "windows", "ci"],
      criterion: "五条断言全过；缺一条就是发布链与声明的形状不一致",
    },
    {
      label: "国密对拍（GM/T 标准向量 ＋ RustCrypto↔Tongsuo 双向）",
      cmd: "node scripts/check-gm-conformance.mjs",
      owners: ["macos", "windows"],
      criterion: "★ 联合验收要求**不跳过**（Tongsuo 缺席时它会自报跳过 ⇒ 那一格不算数）",
    },
    {
      label: "共享 registry 没留补丁（默认构建别被悄悄改掉）",
      cmd: "node scripts/check-gm-registry-clean.mjs",
      owners: ["macos", "windows", "ci"],
      criterion: "原版 / 本次就是 sm-library 构建 ⇒ ok；macOS 默认构建带补丁 ⇒ 红",
    },
  ],
};

// ---------------------------------------------------------------------------
// 平面 2：全库 AI 覆盖
// ---------------------------------------------------------------------------
const COVERAGE = {
  id: "coverage",
  title: "全库 AI 覆盖（派生文本 → 块 → 嵌入 ＋ 覆盖度可度量）",
  why:
    "它的产物（`attachment_text.coverage`、派生表、块/嵌入）与 CRDT 的 `page_crdt` 是**同一张空间库里的邻居**，" +
    "而它读全库的方式（逐页列举 ＋ 全库扫描）正是「存量页面还没补种块身份」那条红线的撞点。",
  probes: [
    {
      id: "cov.report-pure",
      label: "覆盖报告纯计算层（不碰平台，可单独测）",
      kind: "path",
      target: "src/lib/extract/coverageReport.ts",
    },
    {
      id: "cov.entry",
      label: "应用侧取材入口（列页面 ＋ 列附件）",
      kind: "path",
      target: "src/lib/libraryCoverage.ts",
    },
    {
      id: "cov.panel",
      label: "面板入口：用户点得到「检查索引覆盖」",
      kind: "grep",
      file: "src/components/AiSettingsForm.tsx",
      pattern: "检查索引覆盖",
    },
    {
      id: "cov.capability",
      label: "只读能力 `coverage.report` 在注册表里（第一条 `host: frontend`）",
      kind: "grep",
      file: "capabilities/capabilities.json",
      pattern: '"coverage.report"',
    },
    {
      id: "cov.legacy-extractor",
      label: "旧格式 Office 抽取器（平台侧走 LibreOffice headless）",
      kind: "path",
      target: "src/lib/extract/legacy.ts",
    },
    {
      id: "cov.converter",
      label: "本机有 LibreOffice（旧格式**真转换**读数）",
      kind: "cmd",
      target: "soffice",
      external: true,
      how: "需要装了 LibreOffice 的机器（macOS 本机没有 ⇒ 这一格归 AMD 那台）",
    },
    {
      id: "cov.asr",
      label: "ASR 接线（真模型读数需要真模型）",
      kind: "path",
      target: "src/lib/ai/localTranscribe.ts",
    },
    {
      id: "cov.panel-consume",
      label: "面板侧「消费抽取结果」那一层（覆盖方案 §8.0 记的缺口）",
      kind: "manual",
      external: true,
      how:
        "这一层**还没有文件可指**（触发点在导入/附件那条路）⇒ 本机探针量不了它 ⇒ 如实标成外部待办。" +
        "⚠️ 所以 coverage=就绪**只说明「跑得起来」**，不说明这条战役走完了",
    },
    {
      id: "cov.web-cors",
      label: "Web 端 CORS 实测读数",
      kind: "manual",
      external: true,
      how: "真浏览器里跑一次跨源抽取请求；本机不能替代",
    },
  ],
  readings: [
    {
      label: "覆盖报告 ＋ 抽取器（纯函数、注册表、conformance 夹具）",
      cmd: "npx vitest run src/lib/extract src/lib/libraryCoverage.test.ts",
      owners: ["macos", "windows", "ci"],
      criterion: "0 失败；⚠️ 看 `Tests` 那一行**同时**看有没有 `failed suites`（收集失败时用例数会是 0）",
    },
    {
      label: "面板入口（点得到 ＋ 报告渲染得出来）",
      cmd: "npx vitest run src/components/aiSettingsCoverage.test.tsx",
      owners: ["macos", "windows", "ci"],
      criterion: "按钮点击 → 取材 → 报告；等待方式必须是宏任务（微任务等法会把「卡在检查中」读成红）",
    },
    {
      label: "能力注册表完整性（含 `host: frontend` 的三条**反向**断言）",
      cmd: "node scripts/check-capabilities.mjs",
      owners: ["macos", "windows", "ci"],
      criterion: "frontend 能力不许有 Rust 实现、不许进作者 shim/类型包",
    },
  ],
};

// ---------------------------------------------------------------------------
// 平面 3：块级 CRDT
// ---------------------------------------------------------------------------
const CRDT = {
  id: "crdt",
  title: "块级 CRDT（块身份/blockRev ＋ `content_json` ⇄ `ydoc` 平面 ＋ 每页状态落盘）",
  why:
    "它把**每页一份新的权威状态**（`page_crdt`）引进空间库，并且要跨设备合并 —— " +
    "于是它同时踩上另两个平面：加密库上的新表（国密）与「全库扫描会读到老页面」（AI 覆盖）。",
  probes: [
    { id: "crdt.blockrev-ts", label: "块版本纯函数（TS 那份判据）", kind: "path", target: "src/lib/blockRev.ts" },
    { id: "crdt.blockrev-rs", label: "块版本纯函数（Rust 那份判据）", kind: "path", target: "src-tauri/src/block_rev.rs" },
    { id: "crdt.bridge", label: "`content_json` ⇄ `ydoc` 的**唯一实现**（桥接层）", kind: "path", target: "src/lib/crdt/yDocBridge.ts" },
    { id: "crdt.plane", label: "平面开关（默认关 ⇒ 逐字节原样返回）", kind: "path", target: "src/lib/crdt/plane.ts" },
    { id: "crdt.desktop-store", label: "桌面侧每页状态存取（`page_crdt` 的两侧同形）", kind: "path", target: "src-tauri/src/page_crdt.rs" },
    {
      id: "crdt.editor-binding",
      label: "编辑器真的绑上了 Y.Doc（接线只有一处）",
      kind: "grep",
      file: "src/editor/Editor.tsx",
      pattern: "AsyncPageBinding",
    },
    {
      id: "crdt.sprint-doc",
      label: "冲刺计划（S1…S7 的血线与切片）",
      kind: "path",
      target: "docs/plans/2026-09-23-crdt-full-launch-sprint.md",
    },
    {
      id: "crdt.plane-switch",
      label: "平面**开得起来**（今天靠 `VITE_CRDT_PLANE=1`，用户可见的设置项未落地）",
      kind: "manual",
      external: true,
      how:
        "j3、j4 两格的前提：跑的时候要用 `VITE_CRDT_PLANE=1` 起应用/构建（判据里用 `setCrdtPlaneEnabled(true)`）。" +
        "用户可见的**设置项**还没落地 ⇒ 本机探针量不了它，这里如实标成外部条件",
    },
    {
      id: "crdt.server-claim",
      label: "服务端 claim 端点**已发版**（`POST /sync/lineage-claim`）",
      kind: "manual",
      external: true,
      how:
        "服务端那一半在**另一个仓**的分支 `feat/crdt-lineage-claim`（v15 迁移 ＋ 端点），尚未部署 ⇒ " +
        "端点 404 ⇒ 客户端**如实落「离线」那一支**。联合验收里 j6 的「两台各改一块」若要走到**首写者裁定**，" +
        "必须它已发版；没有它时那一支只能按「离线」读，不能记成「裁定通过」",
    },
  ],
  readings: [
    {
      label: "平面与桥接（默认关时逐字节不变 ＋ 路径级判据）",
      cmd: "npx vitest run src/lib/crdt",
      owners: ["macos", "windows", "ci"],
      criterion: "全绿；`plane.path.test.ts` 是「开关成为设置项」的前提清单",
    },
    {
      label: "块版本 ＋ 写层（Rust 侧，与 TS 那份判据相对）",
      cmd: "cargo test --lib --manifest-path src-tauri/Cargo.toml block_rev",
      owners: ["macos", "windows", "ci"],
      criterion: "0 failed",
    },
    {
      label: "每页状态存取（桌面侧，与 TS 表同形）",
      cmd: "cargo test --lib --manifest-path src-tauri/Cargo.toml page_crdt",
      owners: ["macos", "windows", "ci"],
      criterion: "0 failed",
    },
  ],
};

export const PLANES = [SM, COVERAGE, CRDT];

// ---------------------------------------------------------------------------
// 联合格子：**这就是「联合验收」本身** —— 每格都必须跨 ≥2 个平面，否则它属于上面某个平面的
// 单独读数，不该出现在这里（这条由 joint-planes.test.mjs 钉住）。
//   state: landed（今天就能跑，判据在岗） / todo（施工单已写，还没落地） / manual（真机或外部读数）
// ---------------------------------------------------------------------------
export const JOINT_CELLS = [
  {
    id: "j1",
    title: "导出/导入把另两平面的数据一起带走（同一张加密库的快照）",
    planes: ["sm", "coverage", "crdt"],
    state: "landed",
    owner: "macos",
    cmd: "cargo test --lib --manifest-path src-tauri/Cargo.toml workspace_io::",
    // 空跑即红：删掉那条联合判据 ⇒ 读数变 3 ⇒ 低于下限，当场红（`workspace_io::` 今天 4 条）。
    minPassed: 4,
    criterion:
      "空间库加密（会话密钥）→ `snapshot_plaintext` → **不给任何钥**读出 `page_crdt` 的血统行与 " +
      "`attachment_text.coverage`（`snapshot_carries_the_other_two_planes_new_tables`）",
    why:
      "导出走的是**整库在线备份**（不是按表列举）⇒ 新表/新列「看起来」自动随行；「看起来」正是要钉的东西，" +
      "而且这条同时是国密那侧的交界：源库加密时不给钥必须**明确失败**，绝不能产出打不开的坏快照。",
  },
  {
    id: "j2",
    title: "跨后端夹具带上新表/新列（AES 页写的库 ⇄ SM4 页写的库）",
    planes: ["sm", "coverage", "crdt"],
    state: "todo",
    owner: "macos",
    cmd: null,
    criterion:
      "两份页加密夹具都带上 `page_crdt` 一行 ＋ `attachment_text.coverage` 一份读数；" +
      "两种页加密各开各的库、都读得到这两样 ⇒ 新平面没有偷偷依赖「页加密是哪一种」",
    why:
      "现有夹具只钉「页加密是库文件属性」（异或判据），语料只有 `pages`。而联合验收要问的是：" +
      "「另两个平面写进库里的东西，跨后端还读得出来吗」—— 现有夹具回答不了。",
    ref: "施工：`src-tauri/src/security.rs` 的两份夹具生成器（`--ignored --exact` 那两条）＋ `probe_page_cipher_fixture`",
  },
  {
    id: "j3",
    title: "平面开着 ＋ 存量老页面：全库扫描路径不炸（覆盖报告 × 平面）",
    planes: ["coverage", "crdt"],
    state: "todo",
    owner: "macos",
    cmd: null,
    criterion:
      "平面**开着**、库里放一页**没有补种块身份**的存量内容 ⇒ `scanLibraryCoverage` 那条全库读路径" +
      "要么正常出报告、要么如实降级（有痕），**不许抛**",
    why:
      "这条是 CRDT 自己**实测撞出来的**红线（全库扫描会读到未补种的页面）。而覆盖报告恰恰是「一次扫全库」的入口：" +
      "两条线各自绿，交点没人跑过。",
    ref:
      "施工：`src/lib/crdt/plane.path.test.ts` 已有的前置条件清单 ＋ `src/lib/libraryCoverage.test.ts`（平面开那一轮）；" +
      "口径出处 docs/plans/2026-09-23-crdt-slice-b-workorder.md §0.6",
  },
  {
    id: "j4",
    title: "平面开着 ＋ 两设备同步（块级合并走真同步路径）",
    planes: ["crdt", "coverage"],
    state: "todo",
    owner: "macos",
    cmd: null,
    criterion:
      "`verify-two-device-sync.mjs` 的基础上加一轮**平面开着**（`setCrdtPlaneEnabled(true)` ＋ 注入真实现）：" +
      "两台各加一块 ⇒ 两处都在、顺序一致；派生读数（块/嵌入）在合并后**不出现重复**",
    why:
      "现有同步门禁跑的是**默认（平面关）**那一档 ⇒ 它证明的是「老路径没坏」，不是「新路径能合」。" +
      "★ 前提（S4b-1b 的「收」那一侧）2026-09-23 已落地 ⇒ 这一格现在**可以施工**了。",
    ref:
      "施工：`scripts/verify-two-device-sync.mjs`（Node 侧注入平面实现，见 `src/lib/crdt/plane.ts` 的 " +
      "`setCrdtPlaneImpl` / `setCrdtRemoteApplier` 注入约定）",
  },
  {
    id: "j5",
    title: "国密构建下的三平面全量（打补丁 ＋ `sm-library` 跑全量 lib）",
    planes: ["sm", "coverage", "crdt"],
    state: "landed",
    owner: "macos",
    cmd: "node scripts/check-gm-wired.mjs",
    // ★ 这一格最危险的失败形态**不是红，是"自报跳过"**：拿不到 SM 前缀时门禁会 `exit 0` 并说明跳过。
    //   联合验收里那等于"这一格没跑"，**必须**与通过长得不一样 ⇒ 见 joint-acceptance.mjs 的 forbidSkip。
    forbidSkip: true,
    criterion:
      "macOS `failed == 0 且 passed ≥ 380`（实测 520/0）／Windows 同下限（实测 398/0，跳过集不同、**读数不可比**）",
    why:
      "它是**已经存在**的联合读数：全量 lib 里就含 `workspace_io::`（j1）、`derived_transport::`（覆盖度那一列）、" +
      "`page_crdt::` 与 `doc_content::`（CRDT）。⚠️ 但它跑在**平面默认关**的状态 ⇒ **不能**替代 j3/j4。",
  },
  {
    id: "j6",
    title: "真机一次走完三件事（加密开 → CRDT 编辑 → 抽取 → 覆盖报告 → 重启 → 仍可读）",
    planes: ["sm", "coverage", "crdt"],
    state: "manual",
    owner: "owner",
    cmd: null,
    criterion:
      "① 开启磁盘加密 → 新建页并编辑（平面开着）；② 两台设备各改同一页的一块 → 合并后都在；" +
      "③ 附件触发抽取 → 覆盖报告数字变化；④ **重启应用** → 上述内容仍可读（不出现「打不开/空白」）。" +
      "★ ② 若要走到**首写者裁定**，服务端 claim 端点必须**已发版**（未发版 ⇒ 端点 404 ⇒ 客户端如实落「离线」那一支，" +
      "那一支**不许**记成「裁定通过」）",
    why:
      "应用层与库层的交界只在真进程里成立：`page_crdt` 的字节要过 IPC、加密库要过重启、" +
      "覆盖报告要过真实附件。三条各自的本机单测都碰不到这一层。",
    ref: "docs/RELEASING.md（真机验收清单）＋ 本文档 §5 真机剧本",
  },
  {
    id: "j7",
    title: "Windows 静态前缀下复跑 j1/j5",
    planes: ["sm", "coverage", "crdt"],
    state: "manual",
    owner: "amd",
    cmd: null,
    criterion: "静态前缀就绪后 `check-gm-wired` 的 win32 读数 `failed == 0`；j1 那条新判据在 win32 上同绿",
    why: "静态链接是发版那一支的形态；同一份判据在**两种链接形态**下都要成立。",
    ref: "docs/SM-CRYPTO-DELIVERY.md §五（静态前缀那两格）",
  },
  {
    id: "j8",
    title: "Web 端三平面读数（说明差异，而不是凑一个绿）",
    planes: ["coverage", "crdt"],
    state: "manual",
    owner: "macos",
    cmd: null,
    criterion:
      "Web 侧 `page_crdt` 表建得出来、平面开着时逐字节不变（vitest）——**并如实记档**：Web 用 sql.js、**没有 SQLCipher** " +
      "⇒ 国密那一维在 Web 上不存在，联合里它只提供「平面开着」的那一半",
    why: "把「Web 也绿了」写成联合结论，等于用一半的证据说两倍的话。",
    ref: "施工：`npx vitest run src/lib/crdt`（Web 侧 sqliteStore 的 `page_crdt` 建表 ＋ `plane.path.test.ts` 的逐字节不变）",
  },
];

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 一条探针的判定。**IO 全部由调用方注入**（`env`），所以本函数可测、且探针不会偷偷做别的事。
 *
 * @param {{kind:string, target?:string, file?:string, pattern?:string, external?:boolean, how?:string}} probe
 * @param {{exists?:(p:string)=>boolean, hasCommand?:(n:string)=>boolean, readFile?:(p:string)=>string, prefixVerdict?:()=>{ok:boolean, detail:string}}} env
 * @returns {{id?:string, ok:boolean|null, detail:string, external:boolean}}
 *   `ok === null` 表示**未实查**（不是失败）。
 */
export function evaluateProbe(probe, env = {}) {
  const external = Boolean(probe.external);
  const base = { id: probe.id, external, ok: false, detail: "" };
  const { exists = () => false, hasCommand = () => false, readFile = () => "", prefixVerdict } = env;
  switch (probe.kind) {
    case "path": {
      const ok = exists(probe.target);
      return { ...base, ok, detail: ok ? `在位 ${probe.target}` : `缺 ${probe.target}` };
    }
    case "grep": {
      if (!exists(probe.file)) return { ...base, ok: false, detail: `缺文件 ${probe.file}` };
      const hit = readFile(probe.file).includes(probe.pattern);
      return { ...base, ok: hit, detail: hit ? `命中 ${probe.file}` : `${probe.file} 里找不到 ${probe.pattern}` };
    }
    case "cmd": {
      const ok = hasCommand(probe.target);
      return { ...base, ok, detail: ok ? `命令在 PATH 上：${probe.target}` : `PATH 上没有 ${probe.target}` };
    }
    case "prefix": {
      if (typeof prefixVerdict !== "function") return { ...base, ok: null, detail: "未提供前缀探针" };
      const v = prefixVerdict();
      return { ...base, ok: v.ok, detail: v.detail };
    }
    case "manual":
      // 设计如此：需要真机/外部读数的一格**永远是未实查**（本机查不出「别人那台机器上跑没跑过」）。
      return { ...base, ok: null, detail: probe.how ? `未实查（${probe.how}）` : "未实查（需外部读数）" };
    default:
      throw new Error(`未知的探针 kind：${probe.kind}（合法值：${PROBE_KINDS.join(" / ")}）`);
  }
}

/**
 * 一个平面的就绪判定。
 *
 * 规则（别改着玩，改之前先想清楚「本机永远未就绪」的那种退化）：
 *   · `external: true` 的探针**不参与**本机就绪 ⇒ 它们单列成 `pending`；
 *   · 其余探针全部命中 ⇒ `ready`；有一条不命中 ⇒ `not-ready` 并点名。
 */
export function planeReadiness(plane, probeResultsForPlane) {
  const local = probeResultsForPlane.filter((r) => !r.external);
  const pending = probeResultsForPlane.filter((r) => r.external);
  const missing = local.filter((r) => r.ok === false);
  const state = missing.length === 0 ? "ready" : "not-ready";
  return { id: plane.id, state, missing, pending, local: local.length };
}

/** 就绪面板 + 联合矩阵的文本形态（`--plan` 与文档那一块共用同一份渲染 ⇒ 不会两处漂移）。 */
export function renderJointText({ readiness = [], cells = JOINT_CELLS } = {}) {
  const lines = [];
  lines.push(`平面就绪：${readiness.map((r) => `${r.id}=${r.state}`).join(" · ") || "（未测）"}`);
  lines.push("");
  for (const r of readiness) {
    const pending = r.pending.length ? `；外部待读 ${r.pending.length} 条` : "";
    lines.push(`- ${r.id}：${r.state}（本机探针 ${r.local - r.missing.length}/${r.local} 命中${pending}）`);
    for (const m of r.missing) lines.push(`    · 缺：${m.detail}`);
  }
  lines.push("");
  lines.push("联合格子：");
  for (const c of cells) {
    const planes = c.planes.join("+");
    lines.push(`- ${c.id} [${c.state}/${c.owner}] ${planes} — ${c.title}`);
    lines.push(`    命令：${c.cmd ?? "（未落地，见 ref）"}`);
    lines.push(`    判据：${c.criterion}`);
    if (c.ref) lines.push(`    参考：${c.ref}`);
  }
  return lines.join("\n");
}

/**
 * `docs/JOINT-ACCEPTANCE.md` 里那个机器事实块的内容。
 *
 * **它就是登记表本身**（平面、探针、每格的状态/责任方），由测试与文档逐字比对 ⇒
 * 代码动了文档没动就红。刻意只放**会变**的东西（路径、状态、责任方），不放散文。
 */
export function renderDocFacts({ planes = PLANES, cells = JOINT_CELLS } = {}) {
  const out = [];
  out.push(`平面 ${planes.length} 条 · 联合格子 ${cells.length} 个（已落地 ${cells.filter((c) => c.state === "landed").length} / 待施工 ${cells.filter((c) => c.state === "todo").length} / 真机或外部 ${cells.filter((c) => c.state === "manual").length}）`);
  for (const p of planes) {
    const ext = p.probes.filter((x) => x.external).length;
    out.push(`${p.id}：探针 ${p.probes.length} 条（外部待读 ${ext}）· 单独读数 ${p.readings.length} 条`);
  }
  for (const c of cells) out.push(`${c.id} ${c.state} ${c.owner} ${c.planes.join("+")}`);
  return out.join("\n");
}
