// 回归门禁注册表——**门禁清单的单一事实来源**。
//
// 为什么单独一个文件：清单既要被 `scripts/test-report.mjs`（本地 `pnpm verify` 与 CI 共用）
// 消费，也要被 `scripts/test-report.test.mjs` **导入**做不变量自测（id 不重复、命令指向的
// 脚本真实存在、本地默认组不许依赖浏览器……）。放在执行器里就没法安全导入——那边一 import
// 就会跑起整套门禁并 process.exit。
//
// `incident` 字段不是装饰：每条门禁都对应一次真实事故（来自 ci.yml 与各脚本头部的记录）。
// 门禁存在的理由必须写下来，否则后人只会看到"一堆跑得慢的检查"，然后在某次赶工时把它删掉。
//
// 分组：
//   contract —— 纯 Node 契约检查（快，任何机器都能跑）
//   smoke    —— 类型检查 / 单测 / web 冒烟（纯 Node）
//   sync     —— 两设备同步一致性（纯 Node，真实 applyChange + 真实 sql.js）
//   plugin   —— 插件作者路径（类型包 + 作者 CLI + 脚手架冒烟）
//   browser  —— 需要真实 Chromium 的几何 / 加载验收
//   mobile   —— 需要先起 web dev server（:5173）的移动端布局与浮层验收
//   rust     —— cargo test（含插件宿主子进程集成测试）
//   artifact —— 需要"先打一个真包"的外部产物验收（CI 的 rust-tests job 里跑）

export const GATES = [
  // ---- contract ----
  { id: "check-versions", group: "contract", label: "版本号一致性", cmd: "node scripts/check-versions.mjs" },
  {
    id: "check-changelog-version-parity",
    group: "contract",
    label: "CHANGELOG 已发布标题与版本文件同改",
    cmd: "node scripts/check-changelog-version-parity.mjs",
    incident:
      "2026-09-20：一笔提交只把 CHANGELOG 顶部那节写成 1.91.10（没动三个版本文件）⇒ dev 上 `check-versions` 红，" +
      "而它只能说「当前内容不一致」、说不出是哪一笔；本门禁补「哪一笔」，并显式处理 merge（`-m --first-parent`）",
  },
  { id: "check-changelog", group: "contract", label: "CHANGELOG 结构", cmd: "node scripts/check-changelog.mjs" },
  {
    id: "check-changelog-numbers",
    group: "contract",
    label: "CHANGELOG 门禁数字（与基线一致）",
    cmd: "node scripts/check-changelog-gate-numbers.mjs",
    incident: "发版说明里的断言数一直靠人从终端抄：抄错了下一次改动后就成假话，而散文不参与构建，没人会发现",
  },
  {
    id: "check-changelog-tags",
    group: "contract",
    label: "每个 tag 的树自带本版台账段头",
    // 为什么挂在 contract：纯 Node + 只读 git，约 1 秒。**故意不进 `pnpm build`** ——
    // build 会在 release/macos/android 那几个 job 里跑，而那些 checkout 是默认深度（浅克隆）
    // ⇒ 一个 tag 都没有 ⇒ 本门禁判「判不了」（exit 3）⇒ 把发版链整条弄红。
    // 跑它的 `ci.yml` 的 `checks` job 已显式 `fetch-depth: 0`。
    cmd: "node scripts/check-changelog-tags.mjs",
    incident:
      "2026-08-31 一天里连发 7 个 tag（`v1.64.10` … `v1.64.16`），而**每一个的树顶格都还停在 `1.64.10`**" +
      "（`v1.64.10` 自己停在 `1.64.9`）—— 版本号 bump 了、台账一段没写。" +
      "`release-preflight` ③ 查的是「打 tag 之前的工作区」，它挡不住「tag 打在了台账陈旧的提交上」这个形状" +
      "（`git tag` 指哪个提交是手给的）；本门禁对**所有** tag 问「你这棵树里有没有你自己那一段」，是全量历史审计。" +
      "另记一条基线教训：第一版拿「当前 checkout 的 CHANGELOG」去比 tag，报出 4 个假缺失" +
      "（1.85.2 / 1.91.4 / 1.91.25 / 1.91.26）—— 真因是发布提交切在 `main`、`dev` 台账本来就落后两个版本；" +
      "判据的基线必须是被审计的那个对象自己（tag 的树）",
    registered: "2026-09-25",
  },
  {
    id: "check-main-only-commits",
    group: "contract",
    label: "发布线独占提交（漏在 main 上的开发改动）",
    // 为什么挂在 contract：纯 Node + 只读 git，约 1 秒。
    // ⚠️ 它**必须跑在非浅克隆上**：判据要算 `origin/main` 与 `origin/dev` 的祖先关系，而浅克隆下
    // `git rev-list A..B` 会**静默**给出偏少的答案 ⇒ 一律判「判不了」（exit 3），绝不当通过。
    // GitHub 的 `checks` job 是 `fetch-depth: 0`；GitCode 侧由「取全历史与 tag」那一步 `--unshallow`。
    cmd: "node scripts/check-main-only-commits.mjs",
    incident:
      "2026-09-25：`dev` 与 `origin/main` 分叉（dev 独有 208 笔、main 独有 7 笔），那 7 笔里**三笔带着开发线没有的内容**：" +
      "`a3cbd44a`（社区帖存成笔记后属性区不刷新）、`64a415a1`（团队版方案文档）、以及 **`686d0480 release: 1.91.25`**" +
      "—— 标题像纯发布，实际夹带了 `src/lib/mdPreview.ts` 的修复，而那是个**只在打包产物里显形**的 bug：" +
      "节点表在**模块顶层**求值 ＋ 循环 import ⇒ dev/vitest 走原生 ESM 永远绿，打包拼平后 `nodes[9]` 是 `undefined`。" +
      "⇒ 危害不是台账落后，是开发线**长期带着一个已经发出去的 bug**，且下次 `dev → main` 合并冲突取 dev 侧时会静默改回去。" +
      "⇒ **不能只看提交标题判**（那三笔里恰好有一笔就叫 `release:`）⇒ 判据改成按**文件集**：非 merge 的发布线独有提交" +
      "只许动发布产物（`RELEASE_ARTIFACTS`，与 `check-versions` 认的 7 处同源、并由自测钉住不许漂）；" +
      "merge 则要求除第一父外的父都能从 dev 走到（实测那三笔合并的第二父都在 dev 里 ⇒ 不是开后门）。",
    registered: "2026-09-25",
  },
  { id: "check-web-commands", group: "contract", label: "命令契约（web/桌面两侧）", cmd: "node scripts/check-web-commands.mjs" },
  { id: "check-capabilities", group: "contract", label: "能力注册表", cmd: "node scripts/check-capabilities.mjs" },
  {
    id: "check-crdt-snapshot-contract",
    group: "contract",
    label: "CRDT 加密快照的服务端接口契约（三条路由 ＋ 承重规则不许退化）",
    cmd: "node scripts/check-crdt-snapshot-contract.mjs",
    incident:
      "2026-09-29 CRDT 盘点：E2EE 加密快照的协议可行性已验（尖刺 13/0），但服务端接口那一半只有散文施工单 ✗，"
      + "而实现落在另一个仓 ⇒ 契约一旦只存在口头/散文里，最易退化的恰是三条**不可逆**规则："
      + "① 服务端开始解析密文快照 ⇒ 个人空间\"服务端在数学上无法解密\"名存实亡；"
      + "② 先退役旧 blob、后落快照 ⇒ 不可逆丢数据；③ snapshotSeq 由必填变可选 ⇒ 退役范围不明（静默丢数据）。"
      + "本门禁把这三条钉在代码里：服务端实现时**契约先红再绿** ✓",
  },
  { id: "check-doc-links", group: "contract", label: "文档相对链接", cmd: "node scripts/check-doc-links.mjs" },
  {
    id: "check-decision-ids",
    group: "contract",
    label: "决策编号（决策引用必须是 DEC-<n>，不许与需求的 D1–D4 撞车）",
    cmd: "node scripts/check-decision-ids.mjs",
    incident:
      "2026-09-30：一次**独立**的可行性核验把【需求的 D1–D4（交付与部署：可自建／零依赖／AGPL／不许内嵌）】" +
      "当成了待拍清单里的决策项 ⇒ **漏数四个指标**（读到 32，实际 36）。两组同名编号**不会让任何测试变红**，" +
      "只会让人数错/核错 ⇒ 只能靠命名隔离（决策改 `DEC-<n>`）＋本门禁把「残留的裸 D#」钉死。",
    note: "判据形态＝白名单：文档级「自有编号族」清单 ＋ 混用文件的行级语境（脚本头有 5 条规则与边界）",
  },
  // ---- deploy（联网 ⇒ 不进 DEFAULT_GROUPS ✓）----
  {
    id: "check-web-deploy",
    group: "deploy",
    label: "Web 版线上自检（GitHub Pages ＋ 国内主站：版本号与资源可达性）",
    cmd: "node scripts/check-web-deploy.mjs",
    incident:
      "2026-09-29 实测：它此前**只挂在 package.json 的 check:web-deploy 上**——gates.mjs 没注册、"
      + "CI 工作流与文档都没有调用点 ⇒ 按本仓 AGENTS §3 的铁律（只挂 build/package.json 链＝在 verify 与 CI 上**隐形**），"
      + "它属于同源事故的第三次：**能抓到问题，但没人跑**。当天顺手跑它即红 ✗ —— GitHub Pages 的 index.html 引用的 "
      + "`prism/prism-*.js` **404**（v1.84.4 那类\"index 新、资源旧\"）；国内主站 25/25 全可达 ✓。",
    note: "联网 ⇒ 不进默认组；该由每日定时跑（改工作流待 owner 同意 ✓）",
  },
  {
    id: "check-ontology-generated",
    group: "contract",
    label: "本体表与能力注册表一致（生成物不许手改）",
    cmd: "node scripts/check-ontology-generated.mjs",
    incident:
      "2026-09-28：MCP 规格把 `isWrite: true` 当判据（**该字段在 capabilities.json 里出现 0 次** ✗；" +
      "真实字段是 `kind`：read 15 / write 8 / host 2），于是写出了一条「看着像判据、其实指向空气」的规则；" +
      "同一天我还从 6 条样本外推「pages.create 不在注册表里」——也错了 ✗。" +
      "⇒ 本体**由注册表生成**，本门禁逐字节卡漂移",
    registered: "2026-09-28",
  },
  {
    id: "check-invariants-pointers",
    group: "contract",
    label: "规格说能跑的不变式，必须点到存在且已注册的判据",
    cmd: "node scripts/check-invariants-pointers.mjs",
    incident:
      "规格表里写「今天能跑吗 = **能**（`check-xxx`）」是对人下的承诺 ✓。但文档与代码会各自漂移：" +
      "判据被改名／被删／被摘出注册表之后，规格还在说「能跑」✗，读规格的人就以为有承重渠道 ✓ ——" +
      "与「文档说能、其实没人跑」同族。本判据只管两件：**判据文件存在** ＋ **它已注册进 gates.mjs**（否则不进 verify/CI）✓",
    registered: "2026-09-29",
  },
  {
    id: "check-spec-judge-carriers",
    group: "contract",
    label: "规格点名的承重渠道必须真实存在（`check-*.mjs` ／ `mod::tests::name`）＋ §18.1 的 id 卫生",
    cmd: "node scripts/check-spec-judge-carriers.mjs",
    incident:
      "2026-09-30：`nearby-devices-spec` 那族按铁律**不进 `INVARIANTS.md`** ⇒ 既有 `check-invariants-pointers`" +
      "**够不到它**：它只认「≥7 列表里状态含能的行点名一个 `check-*.mjs`」，而这族的判据是 **Rust 单测**" +
      "（`mesh::tests::…`）与 vitest wiring，表也是 4/3 列 ⇒ 硬套只会**逼人写假名字**（假绿）或**一行都解析不到**（假红）。" +
      "⇒ 而「散文里承诺了、机器不盯」今晚已害过三次（编号撞车漏数 4 条／`presence.page_id` 打穿口径／" +
      "`check-licenses` 被写成「已有」却不存在）⇒ 本判据补这一档：**点名了就得在**（Rust 测试名按 `fn <name>` 整名匹配）" +
      "＋ **§18.1 里同一个 id 不许两行都 live、划掉的必须点出取代者**（`DEC-10` 那类病的机器版）。",
    note: "纯 Node、只读文本；边界写在脚本头：**不扫普通路径引用**（那会误伤留痕，如已删的 `nearby_invite.rs`）",
    registered: "2026-09-30",
  },
  {
    id: "check-crdt-plane",
    group: "contract",
    label: "CRDT 平面：content_json 是 TEXT（老客户端只认 JSON）／CRDT 状态只进 BLOB 旁路表／Rust 不认识 CRDT／转换与合并各只有一份实现",
    cmd: "node scripts/check-crdt-plane.mjs",
    incident:
      "混版本共存的**地基是三句话**（见 docs/specs/2026-09-29-crdt-mixed-version-degradation.md）：" +
      "① content_json 永远是 TEXT/JSON（老客户端只认它）② CRDT 状态只进 page_crdt* 的 BLOB ③ Rust 不认识 CRDT。" +
      "这三句**已经写在代码注释里**，但谁把 BLOB 塞进 content_json、给 Rust 加个 yjs crate、或长出第二份转换实现，" +
      "**都不会炸、不会报错、测试全绿** —— 只是**老客户端的页打不开** ✗（本仓 §8 那族：违规不炸，只炸用户）。",
    registered: "2026-09-29",
  },
  {
    id: "check-locked-loud",
    group: "contract",
    label: "锁定 ⇒ 大声失败（稳定错误码 space_locked；不许映射成空）",
    cmd: "node scripts/check-locked-loud.mjs",
    incident:
      "加密空间未解锁时，若把错误吞掉、返回空结果，用户看到的是「没内容」而真相是「你还没解锁」✗" +
      "—— 他会以为数据丢了、去翻备份、去重装。实现其实早就有（plugins.rs:1386 映射成 space_locked，注释原话：" +
      "「插件调用不能成为绕过启动锁的通路」，并有单测 locked_space_maps_to_a_stable_error_code ✓）⇒" +
      "本判据不发明新规矩，只把「映射点 ＋ 稳定码 ＋ 不映射成空 ＋ 有单测」钉成机器可核（纯读源码 ⇒ 不需要 cargo ✓）",
    registered: "2026-09-29",
  },
  {
    id: "check-mcp-host-authz",
    group: "contract",
    label: "MCP 宿主面必须经**同一处**权限校验（不许第二条鉴权路径）",
    cmd: "node scripts/check-mcp-host-authz.mjs",
    // ⚠️ 自报跳过的登记（配合 `test-report.mjs` 的 `--strict-self-skip`；先例 `rust-sm-wired` ✓）：
    //   M1 的宿主面（`src-tauri/src/mcp_host.rs`）**还没写** ⇒ 本条现在没有可检查对象。
    //   跳过 ≠ 通过：要看那次"红"就加 `--require-host`（⇒ exit 2，逐字含「宿主面不存在 / 无可检查对象」）✓。
    selfSkipOk: "MCP 宿主面（src-tauri/src/mcp_host.rs）尚未创建 ⇒ 判据先行阶段没有可检查对象；宿主面落地后本条立即有对象",
    incident:
      "2026-09-30：规格 §2 的 INV-MCP-single-authz 原本第四列是「❌ 无」✗ —— 而宿主面一旦自己开库或自己判权限，" +
      "就长出**第二条鉴权路径** ⇒ 「未解锁大声失败」「写要草稿确认」「每次调用留审计」这些**只对插件那条路成立** ✓，" +
      "外部 agent 从另一条路进来全部绕开，且测试全绿、没有一条门禁会红（本仓最忌的形状）。" +
      "本门禁把「唯一鉴权点存在 ＋ 宿主面调用它 ＋ 不自开库 ＋ 不自判权限」钉成机器可核（纯读源码 ⇒ 不需要 cargo ✓）。",
    // ⚠️ **不设 `baseline: true`**（与 `check-locked-loud` 同形 ✓）：本条不打 `[结果] N 通过 / M 失败` 那种读数行 ⇒
    //   设了它反而会报「通过但没解析出读数 ⇒ 基线校验失效」✗。判据本身的"只看不增"由它自己的自测条数承担 ✓。
    registered: "2026-09-30",
  },
  {
    id: "check-mcp-channel-judge",
    group: "contract",
    label: "MCP 桥的本机通道：默认关 ＋ token ＋ Origin/Host（坏 Origin / 过期 token 必被拒）",
    cmd: "node tools/shuyonote-mcp/judge-channel.mjs",
    // ⚠️ 自报跳过的登记（配合 `--strict-self-skip`；先例 `rust-sm-wired` ✓）：桥还不存在 ⇒ 没有可检查对象。
    //    要看那次"红"就加 `--require-bridge`（⇒ exit 2，逐字含「桥不存在 / 无可检查对象」）✓。
    selfSkipOk: "MCP 桥（tools/shuyonote-mcp/index.mjs）尚未创建 ⇒ 判据先行阶段没有可检查对象；桥落地后本条立即有对象",
    incident:
      "2026-09-30：规格 §2 的 INV-MCP-channel-guarded 原本是「❌ 无」✗。而本仓真栽过同族那次：docs/SECURITY.md 的低危项逐字写着" +
      "「CORS 前缀匹配放过 http://127.0.0.1.evil.com」（lib.rs:155）—— 所以这条判据必须用前缀陷阱值去试，而不是随便一个外域" +
      "（随便一个外域连前缀匹配都挡得住，测不出这个坑 ✗）。四条断言：默认关拒连／坏 Origin 拒／错 token 拒／关闸后旧 token 失效。",
    registered: "2026-09-30",
  },
  {
    id: "check-search-platform-parity",
    group: "contract",
    label: "桌面专属检索能力必须写进 app 侧文档（FTS/BM25 只在桌面，Web 走 LIKE）",
    cmd: "node scripts/check-search-platform-parity.mjs",
    incident:
      "2026-09-30：块级检索在桌面走 FTS5/BM25、Web 走 LIKE（sql.js 没编 FTS5）—— 两边同一个查询**排序可以不同**，" +
      "而这件事此前只写在 db.rs 的注释里；app 侧 commands.ts 的 search_chunks 只写「web 里的同名分支」⇒ " +
      "读代码的人会以为两个平台一样，用户则是「换个平台搜出来顺序变了」且没有线索（本仓最忌的：差异不炸、不报错）。" +
      "本判据把四件事钉住：桌面 DDL 常量在 ＋ 理由（sql.js 没编 FTS5）在 ＋ app 侧写明限定 ＋ 桌面专属 DDL 不许漏进共享 DDL。",
    registered: "2026-09-30",
    baseline: true,
  },
  {
    id: "check-derived-provenance",
    group: "contract",
    label: "派生内容自证来源（ExtractedSegment.kind／loc 必填 ＋ SegmentKind 有区分度）",
    cmd: "node scripts/check-derived-provenance.mjs",
    incident:
      "2026-09-29 读数：派生内容**早已有**「从哪来」的强制字段 —— `ExtractedSegment.kind` ＋ `loc` 都必填 ✓" +
      "（类型注释：「决定检索侧如何展示与加权，也决定 loc 的格式」）。检索、引用、加权全靠它 ⇒" +
      "一旦被改成可选（`loc?`），引用与定位会**静默**降级 ✗ ⇒ 值得一条窄判据。⚠️ 同时更正我先前的错话：" +
      "`source` 列确实存在，但**只属于插件两表**；**内容**层面没有「外部来源」字段 ✗（那是 R55 的真缺口 ✓）",
    registered: "2026-09-29",
  },
  {
    id: "check-audit-shape",
    group: "contract",
    label: "审计的形状（入口唯一 ＋ 条目不含正文 ＋ 只增）",
    cmd: "node scripts/check-audit-shape.mjs",
    incident:
      "2026-09-29 读数：`push_audit(plugin_id, capability, scope, ok, error_code)` 是内存环形队列（容量 500），" +
      "写它的只有 plugins.rs 一个文件 ✓ —— 但当外部助手也能调能力时（M2），审计要答「是谁／哪次会话」，而 plugin_id 答不了 ✗。" +
      "在补字段之前，先把今天已经成立的三条形状钉死：入口唯一（否则漏记 ✗）／条目不含正文（审计不该变成第二份内容副本 ✗）／只增 ✓",
    registered: "2026-09-29",
  },
  {
    id: "check-generated-artifacts",
    group: "contract",
    label: "生成物自证来源（sha）且可重建（生成命令的脚本存在）",
    cmd: "node scripts/check-generated-artifacts.mjs",
    incident:
      "工作区栽过不止一次「生成物与实际脱节而没人发现」——最典型那句：「缺口还开着」在写下 13 分钟后就过期，两天没人看过。知识层的本体表 / 工具面 / 接口指纹都是给人看、给外部程序看的 ⇒ 源改了而生成物没跟上，读的人就照旧结构做 ✗",
    registered: "2026-09-28",
  },
  {
    id: "check-api-surface-version",
    group: "contract",
    label: "外部接口指纹与 `apiVersion` 一致（改了接口必须升版本）",
    cmd: "node scripts/check-api-surface-version.mjs",
    incident:
      "2026-09-28：注册表顶层本来就有 registryVersion / apiVersion ✓，但没有任何东西强制它 ✗ —— 改 id / 删能力 / 改语义时，正在用它的外部程序会在没有信号的情况下坏掉；同一天还实测出 MCP 规格把写判定写成查 isWrite（该字段出现 0 次 ✗）⇒ 接口形状必须机器可查 ✓",
    registered: "2026-09-28",
  },
  {
    id: "check-agent-surface",
    group: "contract",
    label: "外部工具面（生成物）与注册表一致 ＋ 只读面 0 写能力 ＋ 描述无内部标识 ＋ 能力面限于笔记域",
    cmd: "node scripts/check-agent-surface.mjs",
    incident:
      "2026-09-28：注册表里 `ai: true` 恰好 10 条（read 8 / write 2，实测 ✓），而 MCP 规格把写判定写成查 `isWrite`" +
      "——该字段在原始 JSON 里出现 0 次 ✗（真实字段是 `kind`）。同一份 `desc` 里 `content_json` 只出现在**非 ai** 的能力上，" +
      "⇒ 面必须由注册表生成；只读面出现写能力、或描述里写进内部标识 ⇒ 红",
    registered: "2026-09-28",
  },
  {
    id: "check-doc-facts",
    group: "contract",
    label: "文档里的机器事实（门禁 / 能力 / 命令数）与代码一致",
    cmd: "node scripts/check-doc-facts.mjs",
    incident:
      "这三类数字此前散在文档里**靠人手抄**：抄错不报错，只会让照着文档做的人做到一半发现文档是旧的。" +
      "两条断言：① 注册表里每条门禁都要在 docs/TESTING.md 里有名字（上线当天抓到 7 条漏写）；" +
      "② docs/TESTING.md 的「机器事实」块必须与代码逐字一致（数字取自 gates.mjs 与另两条门禁的自报输出，不重复实现）",
    registered: "2026-09-23",
  },
  {
    id: "check-workflow-yaml",
    group: "contract",
    label: "workflow YAML 窄规则 ＋ 私有 CARGO_HOME 交接（按 job）",
    cmd: "node scripts/check-workflow-yaml.mjs",
    incident:
      "2026-09-12：`--lib plugins::` 行尾冒号 ⇒ 非法 YAML ⇒ 0 个 job 的红 run，49 次 push 全红无人察觉；" +
      "2026-09-25：国密隔离后「打补丁」与「构建」之间少一次私有 `CARGO_HOME` 交接 ⇒ Android 自检包在 step 23 如实 panic（`release.yml` 恰好桌面 job 导了、android job 没导 ⇒ 判据必须按 job 切，按文件找会假绿）",
  },
  {
    id: "check-gitcode-workflow-rules",
    group: "contract",
    label: "GitCode workflow 平台规则（runs-on 白名单 / step 必须有 name / action 写法）",
    cmd: "node scripts/check-gitcode-workflow-rules.mjs",
    incident:
      "2026-09-16：GitCode 的校验接口实测出三条平台约束（GitHub 侧没有）——仓库既有的 euleros-2.10.1 与简写 action 都不合法；不合法时整条流水线不会被调度",
  },
  {
    id: "check-overlay-registry",
    group: "contract",
    label: "浮层登记（返回栈 / 移动端量测）",
    cmd: "node scripts/check-overlay-registry.mjs",
    incident: "2026-09-15：版本历史弹层没登记 ⇒ 真机上返回键直接退出应用（第 6 个真机问题）",
  },
  {
    id: "check-hook-order",
    group: "contract",
    label: "hooks 顺序（早退不许越过 hooks）",
    // 为什么现在才进注册表：它此前只挂在 `package.json` 的 build 链上，**没进本注册表**
    // ⇒ `pnpm verify`（本地一键验收与 CI 的 checks job 共用）**跑不到它**。
    // 2026-09-25 复核 Zustand 订阅粒度时发现的 —— 同一个坑 `mobile-views` 在 2026-09-22 踩过
    // （见上面 mobile 组那段注释）。"只挂在 build 链上"的门禁在 CI 的 verify 路径上是隐形的。
    cmd: "node scripts/check-hook-order.mjs",
    incident:
      "同一类错在这份代码里发生过**两次**，两次都是「用户的界面直接没了」：" +
      "① v1.85.1：`CommandPalette` 把参数表单的三个 `useState` 放在 `if (!open) return null` **之后** ⇒ 按 Ctrl+K 抛错（生产是 Minified React error #310）⇒ 整棵树被卸载成白屏；" +
      "② 2026-09-16：`App` 的加密锁定闸门是一句**排在七八个 hooks 之前**的早退 ⇒ 加密安装**重启即抛 `Rendered fewer hooks than expected`**，被根部 ErrorBoundary 接住 ⇒ 用户看到崩溃屏，而锁定屏**一次都没出现过**（真机只验了设置页开关）。" +
      "两次都不是「写错了」，是「**看漏了**」——早退和 hooks 隔着几十行，人眼很难可靠发现；渲染级测试只能证明「某一个组件当前是对的」，这条管的是「仓库里别再出现这种写法」。" +
      "自测：`node scripts/check-hook-order.mjs --self-test`（里面放的是两次真事故的**真实写法**，必须判红）。",
  },
  {
    id: "check-ps1-ascii",
    group: "contract",
    label: "PowerShell 脚本编码（纯 ASCII 或 BOM）",
    cmd: "node scripts/check-ps1-ascii.mjs",
    incident: "2026-09-11：无 BOM 的 UTF-8 .ps1 在 PS 5.1 下按 ANSI 解码 ⇒ 报 9 处假语法错误",
  },
  {
    id: "check-nsis-template",
    group: "contract",
    label: "NSIS 安装器模板（fork 的一行改动 + CLI 版本核对）",
    cmd: "node scripts/check-nsis-template.mjs",
    incident:
      "2026-09-21：owner 截图问「程序的安装地址不专业啊？」——" +
      "Tauri 没有自定义默认安装目录的配置项（只有 installMode，上游 tauri-apps/tauri#11015），" +
      "默认目录写在 NSIS 模板里，所以我们 fork 了一份上游模板只改那一行；" +
      "fork 的两个风险都不吵不闹：模板被删/改回去 ⇒ 又装到 AppData 里（本机那次是注册表记着旧路径，更容易被误判成'产品默认不专业'），" +
      "Tauri CLI 升级后上游模板变了而我们的 fork 停在旧版 ⇒ 与 CLI 传入的占位符对不上，打出来的包装不上",
  },
  {
    id: "check-pdfjs-shim",
    group: "contract",
    label: "pdf.js worker 垫片（顺序不变量，裸 Node）",
    cmd: "node scripts/check-pdfjs-worker-shim.mjs",
    incident: "老 WebView 上打不开任何 PDF：补齐层必须在 worker 内先装，install 顺序最容易被'顺手整理'破坏",
  },
  {
    id: "check-ocr-assets",
    group: "contract",
    label: "OCR 资源清单",
    cmd: "node scripts/check-ocr-assets.mjs",
    incident:
      "两个方向都真发生过（或差一点）：①「整个目录全拷」⇒ tesseract.js-core 的 6 变体 × 2 形态 ≈ 43.2 MiB 里只有一份会被 worker 加载，白白多进产物 ~23.3 MiB（Android 上还会被装两遍，再多约 46 MiB）；②反过来更危险：有人为 worker.detect 打开 legacyCore，而拷贝脚本仍只放 -lstm 三档 ⇒ 本地 OCR 在真机上只报一个看不懂的加载错误，构建 / 单测 / 类型检查全都发现不了",
  },
  {
    id: "check-deep-link",
    group: "contract",
    label: "deep-link 交付通道",
    cmd: "node scripts/check-deep-link.mjs",
    incident:
      "这条链上每个断点的表现都是「什么都没发生」（点链接、应用无反应、控制台也不报错），而且四类断点都不是编译错误：scheme 写错或被删、single-instance 少了 deep-link feature（URL 被静默丢掉，窗口照常去所以看起来像解析失败）、lib.rs 忘注册插件或忘接事件、事件名前后端不一致",
  },
  {
    id: "check-plugin-hosting",
    group: "contract",
    label: "插件托管",
    cmd: "node scripts/check-plugin-hosting.mjs",
    incident:
      "应用侧门禁（external_index / external_package）验的是「文件」，而托管方要保证的是「线上那一份」能装：两类是「发布时毫无征兆、用户端才炸」—— 索引被长缓存 ⇒ 新插件永远看不到；包被 no-store 或被 CDN 改写 ⇒ 每次安装都重下几 MB（慢，但不报错）",
  },
  {
    id: "check-sys-deps",
    group: "contract",
    label: "构建期依赖登记 / 本机工具链（以 CI 配方为准）",
    // ⚠️ 这里**故意不带 `deb`**：Linux 的 deb 实查要求 Tauri 那套系统包在位，而本组跑在
    // `checks` job（ubuntu-latest，**不装** Tauri 依赖）⇒ 带上它第一条 push 就会红，且红得没道理。
    // deb 实查挂 rust 组的 `check-sys-deps-linux`，那条跑在装了依赖的 `rust-tests` job 里。
    cmd: "node scripts/check-sys-deps.mjs --checks registration,toolchain",
    incident:
      "两类真事故各一条：①2026-09-17 发版机清构建期依赖（libssl-dev）⇒ 社区端 openssl-sys 编译失败；②同日 15:51 本机 Xcode 27 装完许可未接受 ⇒ git/python3/cc/xcrun 全线不可用（notarytool 一条探针就能提前发现）",
    // ⚠️ 2026-09-27：**自报跳过的登记**（配合 `test-report.mjs` 的 `--strict-self-skip`）。
    // 实测（dev CI，run #613，`139072b6`）本组在 Linux 上报「自报跳过 1 条」，跳过的是
    // **平台工具链探针**那一档（`check-sys-deps.mjs` 的 `probeSkipped`：macOS / Windows 各一张表，
    // 别的平台显式跳过 —— 见该脚本 436 行前后）。
    // 而 Linux 侧该跑的那半是 **deb 实查**：它**故意不带 `deb`** 挂在本组、另挂在 rust 组的
    // `check-sys-deps-linux`（那条跑在**装了 Tauri 依赖**的 `rust-tests` job 里，见本条目上方注释）
    // ⇒ **跳过是平台分工，不是漏验**（每台机器只跑它那一侧的判据）。
    // 登记 ≠ 通过：它只让「绿里面有跳过」这件事**有名字**，并在 `--strict-self-skip` 里豁免这一条。
    selfSkipOk: "Linux 上跳过的是平台工具链探针（macOS/Windows 各一张表）；Linux 侧该跑的 deb 实查另挂在 rust 组的 check-sys-deps-linux（装了 Tauri 依赖的 job）⇒ 平台分工，不是漏验",
  },
  {
    id: "check-derived-writers",
    group: "contract",
    label: "派生表唯一写入者（Rust 生产代码不许写 attachment_text / chunks）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒。
    cmd: "node scripts/check-derived-writers.mjs",
    incident:
      "2026-09-18 spike 问题二查出**正文文本有两条派生实现**（7 个样本里 4 个结果不同，症状是搜索片段/反链随『谁最后保存』变）；同族风险是派生**表**长出第二个写入者 —— 两边各写一份时两侧测试都绿，用户看到的是同一份附件两套派生文本。Windows 裁定「写只有一处（TS 抽取管线：src/lib/extract/store.ts / chunkStore.ts）」，并要求把这条落成**可执行判据**（原话：只写在文档里的规则会漂）。Rust 侧今天确有两处 INSERT，但都在 #[cfg(test)] 里播种夹具 ⇒ 判据必须做区域判定（与 check-doc-content-access 共用 scripts/lib/rust-scan.mjs）",
  },
  {
    id: "check-doc-content-access",
    group: "contract",
    label: "文档内容直接访问（只减不增：新文件 / 超基线即红）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、约 1 秒 ⇒ 本机默认组与 CI 的 `checks` job 都能跑。
    cmd: "node scripts/check-doc-content-access.mjs",
    incident:
      "同页并发 → 全量 CRDT（路线 C）要换实现时，全仓直接摸 content_json / content_text / contentJson 的面是 746 次 / 80 个文件；不把「只经一层（read/write/merge/derive）」做成单调收敛的机器判据，收口就只能靠一次大爆炸重构，而且新写的直接访问没有任何东西会拦（今天已经有人把 542 行 / 26 文件这个错口径当成规模）",
  },

  {
    id: "check-prism-components",
    group: "contract",
    label: "代码块高亮只有一条装配路径（不许再有 vendored 的 Prism script）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒（只读 index.html ＋ 两个源文件 ＋ 目录是否还在）。
    cmd: "node scripts/check-prism-components.mjs",
    incident:
      "2026-09-25 清冗余文件时实测：仓库里本来有**两条并行的 Prism 装配路径** —— " +
      "① `index.html` 里 10 行 `<script src=\"prism/prism-*.js\">` ＋ `public/prism/` 下 10 份 vendored 组件（77 KB，且是**阻塞式** script）；" +
      "② `src/editor/prismSetup.ts`（`Editor.tsx` 启动时 import）：prismjs 核心 ＋ 16 个组件 ＋ `window.Prism ??= Prism` —— 它自己的注释就写着 " +
      "\"independent of the index.html plain <script> loading\"。两条路做的事完全重合 ⇒ ①是纯冗余。" +
      "真 Chromium 实测（把①整条去掉后重新加载）：`window.Prism` 照旧能 highlight json / rust / sql / go / markdown、页面零 JS 报错 ⇒ 已删。" +
      "⚠️ 本门禁的第一版把方向判反了（写成「vendored ⇒ 必须在 index.html 里被加载」）：那条规则会**逼着**冗余的第二条路继续存在，" +
      "而它唯一的「证据」（`prism-json.js` 没被加载）真相是**两条路都不该有①** —— 先量事实再写判据，这条留作记录。" +
      "另有**只报告不判红**的静态对账：选择器列了、而 `prismSetup.ts` 没显式 import 的语言（今天 markdown / yaml）。",
    registered: "2026-09-25",
  },
  {
    id: "check-plan-status",
    group: "contract",
    label: "方案状态位与完成的证据（每篇 plan 头部要有 `状态：`；报完成必须带可核证据；只减不增）",
    // 为什么挂在 contract：纯 Node、只读文本、离线、<1 秒。
    cmd: "node scripts/check-plan-status.mjs",
    incident:
      "2026-09-27 给 `docs/plans/`（91 篇）做状态盘点时实测：**「写状态」这件事是 `2026-08-24` 才成为习惯的** —— " +
      "08-24 起的方案头部统一是 `> 目标版本：…` ＋ `> 状态：规划（建议）。…`，而 08-22 及更早那批是 " +
      "`# 标题` → `> 目标：…` → `## 1. 背景与竞品对照`，**根本没有状态这一行**。全文扫出来是 **51 篇没有状态行 ＋ 13 篇自报完成却没有证据**。 " +
      "后果是具体的、不是洁癖：那批里好几篇的功能**早已落地**（`docs/roadmap.md` 有 `✅ M9（v1.13.0）` / `✅ M10（v1.11.0）` / `✅ M12（v1.33.0）` / `✅ M13（v1.25.0）` / `✅ M14（v1.37.0）`，都带版本号）， " +
      "**可它们在文档里和「未实装」长得一模一样** ⇒ 读文档的人（包括 agent）分不出哪些还有效。本仓 `scripts/lib/docs-index.mjs` 的注释已记着这条后果：「新会话按文档入口找不到那一篇，于是**同一件事被第二次立项**（本仓已经有过\"两份口径\"的教训）」。 " +
      "⚠️ 本门禁的第一版**发明了一个状态词表**，于是 24 篇被判「状态词非法」—— 而真相是仓库在用的词有十几种（`已收口` `已实现` `已拍板` `已定` `规划` `提议` `施工单` `决策/建议` `进度口径` `待拍板` …）。 " +
      "⇒ **判据改成自由文本**，只判「头部有没有 `状态：`」＋「报完成（已完成/已实现/已收口/已落地/已拍板/已定）有没有可核的 `证据：`」；没见过的词只提醒、不判红。 " +
      "第一版还有第二个错：扫**全文**找状态，于是正文里 `状态：施工单（…）` 这种**别的字段**被误判成方案状态 ⇒ 现在只在**第一个 `## ` 标题之前**找。 " +
      "旧账用 `scripts/plan-status-baseline.json` 冻结（只减不增，与 `check-store-subscriptions` 同一套纪律）—— 上线当天 64 处，**没有基线这门槛第一天就会被绕开或被删**。",
    registered: "2026-09-27",
  },
  {
    id: "check-store-subscriptions",
    group: "contract",
    label: "Zustand 订阅粒度（组件不许整店订阅；只减不增）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒。
    cmd: "node scripts/check-store-subscriptions.mjs",
    incident:
      "2026-09-25 复核技术选型评估里「Zustand 在多空间/多视图的规模下需警惕隐式依赖导致的重渲染」这一条时实测：213 个 store 调用点里 **39 处 / 32 个文件**是 `const { openPage } = useNotes();` 这种**不带选择器**的整店订阅，" +
      "而 action 引用恒定、本来一次都不该被唤醒——其中 13 处**一个 state 字段都没读**。最重的一处是 `PageTree.tsx:189` 的 `TreeItem`：它**每个可见树节点渲染一次**，却也整店订阅；" +
      "叠加「自动保存（600ms 去抖）每次都 `updateCurrent()` ＋ `loadPages()` 全量重拉」⇒ 打一次字停 1 秒就唤醒 ~24 个树节点实例，外加 DatabaseView(1751 行) / FileManagerView(1208 行) / SyncPanel(1071 行) / GraphView / CommandPalette 一起重跑 render。" +
      "它与 check-hook-order 同族：**不炸、不报错、测试全绿**，只是安静地多渲染；写的人也没写错，是没人告诉过他「这行是订阅」⇒ 只能靠机器判据钉住（判据是**订阅关系**，不是渲染耗时，边界写在脚本头部）。",
  },
  {
    id: "check-dead-code-receipts",
    group: "contract",
    label: "死代码收据（`allow(dead_code)` 必须带日期 ＋ 删除条件）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒（只读 `src-tauri/src` 与 `build.rs` 的文本）。
    // ⚠️ 它**不判**理由好不好、也不判那段代码该不该留：它只保证"有人签过字"（边界写在脚本头部）。
    cmd: "node scripts/check-dead-code-receipts.mjs",
    incident:
      "2026-09-25 给「清掉编译器报的死代码」收尾时做了一轮全仓稽查，发现的不是「有几个警告要修」，而是**这一整类东西没人管**（`allow(dead_code)` 不产生任何输出，所以过期了也没人会去看）：" +
      "① `sync.rs::IncomingChange.seq` 挂着豁免，而它其实被生产代码读了 8 处 —— 豁免早就过期；" +
      "② `commands.rs::mupdf_compiled()` 的 body 就是 `cfg!(feature)`，唯一使用者是一条 `assert_eq!(cfg!(f), cfg!(f))` 的**空转判据** —— 死代码还自己长了一条判据；" +
      "③ `security.rs` 一次「文档与属性被留在上一个函数下面」的事故让一个夹具生成器被 libtest **注册两遍**（跑两遍），另一条生成器彻底不可达；" +
      "④ `build.rs` 里留着一份搬走后的 `find_gm_marker_deprecated` 副本，靠无名无期的豁免挂着（本次删除）。" +
      "共同点：**一行豁免就让一整块东西免检**。本门禁把纪律变成断言：每处豁免要么删掉、要么门进 `#[cfg(test)]`、要么写一句 `// ★ YYYY-MM-DD 收据：为什么留 ＋ 什么时候删`。" +
      "⚠️ 命中必须**在代码里**（复用 `lib/rust-scan.mjs` 掩码）：仓里有十几处注释**在讲**这件事，grep 式扫描会把它们全算成违规（自测里有这一格）。",
    registered: "2026-09-25",
  },

  // ---- smoke ----
  { id: "tsc", group: "smoke", label: "类型检查（tsc --noEmit）", cmd: "pnpm exec tsc --noEmit" },
  {
    id: "vitest",
    group: "smoke",
    label: "单元测试（vitest）",
    cmd: "pnpm exec vitest run --reporter=json --outputFile={tmp}/vitest.json",
    counters: "vitest",
    baseline: true,
  },
  {
    id: "smoke-web",
    group: "smoke",
    label: "冒烟测试（web 平台行为的事实标准）",
    cmd: "node scripts/smoke-web.mjs --json {tmp}/smoke-web.json",
    counters: "smoke-web",
    baseline: true,
    incident: "曾因一处无守卫的 localStorage 访问整套崩掉，而**没有任何自动化在跑它**，长期无人察觉",
  },

  // ---- sync ----
  {
    id: "two-device-sync",
    group: "sync",
    label: "同步一致性（两设备并发，真实 applyChange + 真实 sql.js）",
    cmd: "node scripts/verify-two-device-sync.mjs",
  },

  // ---- plugin ----
  { id: "examples-tsc", group: "plugin", label: "示例插件类型检查", cmd: "pnpm exec tsc -p examples/plugins" },
  { id: "plugin-cli-validate", group: "plugin", label: "作者 CLI 校验示例插件", runner: "plugin-cli" },
  {
    id: "plugin-new-smoke",
    group: "plugin",
    label: "脚手架冒烟（生成的起点当场能过 CLI）",
    cmd: "node scripts/plugin-new.mjs ci-smoke-plugin {tmp}/plugin-new-smoke",
  },

  // ---- browser（真实 Chromium）----
  {
    id: "check-pdf-reload",
    group: "browser",
    label: "PDF 重复加载验收（真实 Chromium + 真实引擎）",
    cmd: "node scripts/check-pdf-reload.mjs",
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "React StrictMode 让加载 effect 跑两遍，第二次交出已 detach 的 buffer ⇒ 单测摸不到",
  },
  {
    id: "check-panel-layout",
    group: "browser",
    label: "面板布局几何（真实 Chromium）",
    cmd: "node scripts/check-panel-layout.mjs",
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "'文字被挤成一条竖柱'这类：happy-dom 不做布局、类型检查看不见，只有打开看一眼才发现",
  },
  {
    id: "check-web-build",
    group: "browser",
    label: "Web 构建产物自检（真实 Chromium）",
    cmd: ["pnpm build:web", "node scripts/check-web-build.mjs"],
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "v1.84.1：按静态引用过滤删旧文件，把 sql.js wasm / pdf worker 删了 ⇒ 页面照开、DB 初始化失败",
  },

  // ---- mobile（需先起 dev server）----
  // browser / mobile 这两组要真实 Chromium（+ dev server），是仓库里唯一有 flake 风险的档。
  // 标记 `flaky: true` **不是**允许它们随便红：只有显式 `--retry N` 时才重试，
  // 且重试一定写进报告（"靠重试才通过"会单独列一节）。CI 默认 0 次重试——flake 要吵出来。
  { id: "mobile-layout", group: "mobile", label: "移动端布局验收（真实 Chromium）", cmd: "node scripts/verify-mobile-layout.mjs", baseline: true, counters: "auto", flaky: true },
  { id: "mobile-overlays", group: "mobile", label: "浮层 / 弹窗验收（真实 Chromium）", cmd: "node scripts/verify-mobile-overlays.mjs", baseline: true, counters: "auto", flaky: true },
  // 主区里的**整视图**（笔记/看板/关系图/文件/数据库 8 模式 + 属性表 + 小控件 + PDF 阅读器真 DOM）。
  // 2026-09-22 补进注册表：它此前只挂在 package.json（`test:mobile-views`），`pnpm verify` 跑不到它。
  { id: "mobile-views", group: "mobile", label: "主视图移动端验收（真实 Chromium）", cmd: "node scripts/verify-mobile-views.mjs", baseline: true, counters: "auto", flaky: true },

  // ---- rust ----
  // 读数（`counters: "cargo"`）**已在 Linux 侧实测并入** tests/baseline.json：
  //   rust-test 310 / rust-plugins-alone 114（2026-09-16，dev=dc7fa13b，WSL2 Ubuntu 24.04）。
  // 本机 Windows 可以用 scripts/win-cargo-test.ps1 跑 **lib 目标**（cargo 生成的测试 exe 没有
  // 应用清单，加载器因此绑到旧 comctl32 ⇒ 0xC0000139；脚本注入 v6 清单后再跑）。但它只覆盖单测，
  // 不含要真宿主进程的 `plugins::` 那 34 条，整组仍以 Linux（CI / 本机 WSL）为准，见
  // docs/TESTING.md 的"已知边界"。所以本机 `pnpm verify:rust` 仍可能红——那是**能力**问题；
  // 基线校验只比较**跑通过**的门禁，本机红不产生假违规。
  {
    id: "rust-test",
    group: "rust",
    label: "Rust 单测 + 集成测试（cargo test）",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml",
    counters: "cargo",
    baseline: true,
  },
  {
    id: "rust-plugins-alone",
    group: "rust",
    label: "插件测试必须能单独跑",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib plugins::",
    counters: "cargo",
    baseline: true,
    incident: "2026-09-13：某测试依赖进程级 APP_DATA_DIR ⇒ 单跑必红、全量反而绿，改一行只跑一条时极易误判",
  },
  {
    id: "gm-conformance",
    group: "rust",
    label: "国密对拍（GM/T 标准向量 ＋ RustCrypto↔Tongsuo 双向）",
    // 为什么在 rust 组：它是 cargo 驱动的（`tools/gm-conformance` 这个独立工具 crate），
    // 与 rust-test 同一个 CI job；Tongsuo 缺席时**自报跳过**（不装绿、也不冒充通过）。
    cmd: "node scripts/check-gm-conformance.mjs",
    incident:
      "国密这条线**同时保两份 SM4 实现**（应用层 RustCrypto / 库级 Tongsuo，见方案 §0-F）——两份漂移的后果是「跨设备读不出对方的数据」，而它没有任何编译期信号、本机单测也照绿。夹具来自 AMD 2026-09-17（信箱仓 gm-conformance），2026-09-19 搬进本仓：去 target/、驱动重写成跨平台 Node（原 driver.sh 是 Linux 专用：stat -c/sha256sum/$HOME/tongsuo-build）、Tongsuo 缺席自报跳过；并加「空跑即红」下限——固定下限会漏掉「Tongsuo 分支整段被删」，所以下限随 Tongsuo 是否参与而变（3 或 8）",
    // ⚠️ 2026-09-27：**自报跳过的登记**（配合 `test-report.mjs` 的 `--strict-self-skip`）。
    // 实测（dev CI，run #613 / `139072b6`）：本门禁在 CI 上报「自报跳过 1 条」，
    // 跳的是**跨实现对拍 9 项**（T1 标准向量 2 ＋ T2/T3 双向互解 2 ＋ T4 密文一致/HMAC 一致 2 ＋ T5 KDF 口径 3），
    // 原因是 CI **没装 Tongsuo**；同一次跑里 `gm-conformance: ✅ 通过 —— 跑成 3 个用例`（R1–R4 覆盖的是「实现没被改坏」）。
    // ⚠️ **它与 `check-sys-deps` 那种「平台分工」不同**：这 9 项**没有第二个平台会跑**
    //    （CI 没装；Windows 本机 `node scripts/check-gm-conformance.mjs` ⇒ exit 1）⇒ **这是真的没验过**。
    // 登记 ≠ 通过：它只让「绿里面有跳过」这件事**有名字**、并在严格模式里豁免这一条。
    // 目标仍是**在有 Tongsuo 的环境里真跑**（CI 装 Tongsuo 是一个小项目；先向 macOS/AMD 要一次那 9 项的读数）。
    // ⚠️ **发版说明必须记「未验」** —— 本版不得把这一格当成「跨实现一致已验」的证据。
    selfSkipOk: "CI 未装 Tongsuo ⇒ 跨实现对拍 9 项跳过（R1–R4 已覆盖「实现没被改坏」；**发版说明须记「未验」**）；目标是在有 Tongsuo 的环境真跑",
  },
  {
    id: "rust-no-sm-crypto",
    group: "rust",
    label: "回滚通道：关掉默认特性（不编国密）仍能编译 ＋ 全量单测",
    // ★ 2026-09-20 改造（owner 拍板「无兼容快路」后，方案 §3.4）：
    //   原先这条门禁跑 `--features sm-crypto`，理由是"国密整段在 feature 后面，默认构建一行都不编，
    //   默认 CI 全绿证明不了国密那半边"。**那条理由现在反过来了** —— `sm-crypto` 已是**默认特性**
    //   ⇒ 默认门禁（`rust-test`）跑的就是国密那半边，原命令与它**逐值相同**，成了纯粹的重复。
    //   而快路带来了一条**新的、真正没人验证**的路径：`--no-default-features`（一行可逆的**回滚通道**）。
    //   它同样"没人编就会腐烂"（比如有人删掉只被旧路径用到的辅助函数），所以把这条常开门禁**改指它**。
    //   ⚠️ 改名不是洁癖：一个叫 `rust-sm-crypto` 却在验证"不编国密"的门禁，正是我们自己最反对的那种
    //   "名字比它证明的事多"。旧读数 `rust-sm-crypto: 398` 随之作废（同一条命令现在由 `rust-test` 覆盖）。
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --no-default-features",
    counters: "cargo",
    baseline: true,
    incident:
      "2026-09-20：`sm-crypto` 成为默认特性后，原 `rust-sm-crypto`（跑 --features sm-crypto）与 `rust-test` 变成同一条命令；本门禁改为验证**回滚通道**（--no-default-features）——它是「一行可逆」这个承诺的实现，没人编就会腐烂。",
  },
  {
    id: "rust-sm-wired",
    group: "rust",
    label: "库级国密**接线**构建：打补丁 ＋ `--features sm-library` 下的全量单测",
    // ★ 2026-09-22 加，动机是**一次真实事故**：应用接线（`apply_gm_page_settings`）整段在
    //   `#[cfg(feature = "sm-library")]` 后面，而 CI 原有的 rust 门禁**全部跑默认特性**
    //   ⇒ 那条路**没有任何门禁碰过**。我在本机把发版链原样跑一遍时踩到的那个坑
    //   （`--prepare` 只清 dev profile ⇒ release 的旧 CommonCrypto SQLCipher 被原样复用
    //   ⇒ 包表面全对而库级不是国密）就是这一类，只有产物断言抓住。
    //   本门禁把它变成常开：能拿到 SM 版 OpenSSL 前缀就真跑（Linux 用 `/usr`），拿不到**自报跳过**。
    //   ⚠️ 它跑完会**还原补丁并把默认特性重新编好** —— 否则同一 job 里后面的 `check-crypto-backend`
    //   会读到"补丁态 ＋ openssl 最新产物"而按平台默认声明判红。
    cmd: "node scripts/check-gm-wired.mjs",
    // ⚠️ 2026-09-27：**自报跳过的登记**（配合 `test-report.mjs` 的 `--strict-self-skip`）。
    // 为什么这台机器上跳过是可接受的：本门禁要的是**装了 SM 版（Tongsuo / SM-OpenSSL）的 OpenSSL 前缀**，
    // Linux runner 用 `/usr` 拿得到，Windows 开发机上没有那个前缀是常态。
    // ⚠️ 登记 ≠ 通过：它只让「绿里面有跳过」这件事**有名字**，并在严格模式里豁免这一条。
    //    实测（2026-09-27，本机聚合器）：`--only rust-sm-wired` ⇒ `status=passed`、`ok=true`，
    //    而 `skips` 里躺着门禁自己写的「! 跳过（自报跳过，不装绿）…」—— 采到了却没人看，这就是登记的理由。
    selfSkipOk: "需要 SM 版 OpenSSL 前缀；Windows 开发机没有该前缀是常态（Linux CI 的 /usr 有）",
    incident:
      "2026-09-22：接线那段（`set_cipher_key` → 能力探针/设标签/回显校验）没有任何 CI 门禁覆盖；同时在 macOS 本机发现「只清 dev profile ⇒ release 旧 SQLCipher 被复用 ⇒ 发出非国密包」。两者一起促成本门禁：打补丁 ＋ 清两个 profile ＋ `--features sm-library` 跑全量单测（内部下限 380 passed/0 failed，空跑即红），跑完还原补丁并重建默认特性，避免留下混态。",
  },
  {
    id: "gm-registry-clean",
    group: "rust",
    label: "共享 registry 没留国密补丁（默认构建别被它悄悄改掉）",
    // 为什么挂在 rust 组：它读的是 cargo registry 里那份 **libsqlite3-sys 的 SQLCipher 源码**，
    // 而那正是 rust 组所有 cargo 门禁会去编译的同一份源码。
    // 三档：原版 / "这次就是 sm-library 构建" ⇒ ok；带补丁但本平台不红 ⇒ **只提示不判红**；
    // 带补丁 ∧ macOS 默认构建 ⇒ **红**（那 12＋7 条红会伪装成"加密库坏了"）。
    // 读不出来（没跑过 cargo / 拿不到 Cargo.lock）⇒ 只提示，**不判红**。
    cmd: "node scripts/check-gm-registry-clean.mjs",
    incident:
      "2026-09-22（AMD 侧报的，方案 §五「macOS-only 风险：补丁留在共享 registry 上」）：补丁打在**全机共享**的 `libsqlite3-sys-<v>/sqlcipher/sqlite3.c` 上，而 `sm-library-build.mjs` **刻意不自动还原**（自动还原会造出「源码是 AES、产物是 SM4」的新静默态）⇒「跑过一次国密构建、忘了 --revert」会在 macOS 上让后续**默认**构建红 12＋7 条，而**现场长得像「加密库坏了」**（`PRAGMA key = \"x'…'\"` 被拒），不是一眼能认出「这是补丁残留」；Linux/Windows 上不红、但后续默认构建被**静默**改成写 SM4 页。原先唯一的防线是收尾横幅＋人的纪律 ⇒ 这条把纪律变成断言（并且**只读**：`--print-source-sha256`/`--require-static`/`--print-env` 都会先打补丁，想核状态反而会改状态）。 ★ 2026-09-26 补记：**上面这一档自 2026-09-23 起已是历史形态** —— 补丁改为打在**私有副本**（`.gm-build/`）上，共享 registry **全程不被改写**（见 `sm-library-build.mjs` §0.5b 与 `patches/README.md`）。本门禁今天守的是两处**残渣**：① 老机器上遗留的共享补丁（legacy 撤回分支仍在）；② `Cargo.lock` 被 `--prepare` 改过。实测（2026-09-26 本机）：`--prepare` 前后共享 `sqlite3.c` 的 sha256 都是 `EA0BF0B0…`（未变）⇒ 隔离生效。**留这段是因为旧描述会让人不敢跑那一步 —— 过期的危害描述与过期的安全承诺一样贵。**",
    // ⚠️ 2026-09-27：**自报跳过的登记**（配合 `test-report.mjs` 的 `--strict-self-skip`）。
    // 本门禁在**读不到共享 registry 源码**时**有意不判红**（干净机器 / 还没跑过 cargo 都会走到那里；
    // 判红就等于逼人在无依赖机器上红 —— 见上面第 462 行那句「读不出来 ⇒ 只提示，**不判红**」）。
    // ⚠️ 但"没查"必须**看得见**：2026-09-27 之前那两行消息**不以 `! ` 开头** ⇒ `report-core.mjs` 的
    // `extractSkips()`（只认**行首** `⏭`/`!`/`✗ skip`/`SKIP`）**采集不到** ⇒ 这一格在报告里是**静默绿**，
    // 而那正是隔壁 `check-sys-deps` 明写反对的形状（它的原话：「不能当成『没 dpkg 所以跳过』，那正是『没查却显示绿』」）。
    // ⇒ 本轮给那两行加 `! ` 前缀，并加测试 `scripts/check-gm-registry-clean.test.mjs`（4 条，
    //   含「去掉前缀 ⇒ 采集不到」的反事实）。登记 ≠ 通过：首选路径仍是在**跑过 cargo** 的机器上真核对。
    selfSkipOk: "读不到共享 registry 源码时不判红（干净机器/没跑过 cargo 的常态；判红会逼人在无依赖机器上红）—— 已改为走自报跳过通道，可见可登记",
  },
  {
    id: "check-crypto-backend",
    group: "rust",
    label: "SQLCipher 的加密后端与声明一致（构建期实查，不是看环境变量）",
    // 为什么挂在 rust 组、且排在 cargo 类门禁后面：它读的是**构建产物**里 libsqlite3-sys 的 `output`
    // （`-DSQLCIPHER_CRYPTO_CC` / `link-lib=dylib=crypto`），所以必须先把东西编出来才查得到；
    // 没有产物时**自报跳过**（"没编过"不等于"编错了"）。
    cmd: "node scripts/check-crypto-backend.mjs",
    incident:
      "2026-09-19（本门禁作者本人踩的）：按方案 §3 第 5 条设了 OPENSSL_DIR=<Tongsuo> 跑 cargo test —— 编译通过、测试全绿、产物里**仍然是 framework=Security（CommonCrypto）**。原因是 libsqlite3-sys 的 build.rs **没有**为 OPENSSL_DIR 声明 rerun-if-env-changed ⇒ cargo 认为环境没变 ⇒ 构建脚本根本没重跑。⇒「设了环境变量」≠「换了后端」，必须 cargo clean -p libsqlite3-sys。这条门禁就是拿产物说话：声明与实际不一致就红（本机两种方向都实测过），旧产物分类不同只提示不判红。⚠️ macOS 今天默认仍是 CommonCrypto（Apple 那支只有 AES）⇒ 平台声明里 darwin 现写 commoncrypto，等 P2/P3 的 provider 补丁落地时随构建配置一起改成 openssl",
  },
  {
    id: "check-sys-deps-linux",
    group: "rust",
    label: "构建期系统依赖（dpkg 实查，与本组 CI job 的 apt 配方同源）",
    // 为什么挂在 rust 组：这是**唯一**会编译整个 Rust 工作区的 job，也就是唯一该要求
    // 「Tauri 那套系统包在位」的地方。本机 macOS/Windows 上这条会显式打印「未实查」而不是装绿。
    cmd: "node scripts/check-sys-deps.mjs --checks registration,deb",
    incident:
      "2026-09-17：发布机把 libssl-dev 当「客户端专用」清掉 ⇒ openssl-sys 构建失败。判据不是「表里写了什么」，而是「CI 配方装的包这台机器有没有」——表里的硬判据必须能在 ci.yml 的 Linux system deps 步里找到，否则门禁自己就是假话",
  },

  // ---- artifact（需先打一个真包；缺环境变量时显式跳过，绝不冒充通过）----
  {
    id: "external-index",
    group: "artifact",
    label: "外部索引：应用真解析器验收",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib external_index -- --ignored --nocapture",
    requiresEnv: ["SHUYONOTE_INDEX_FIXTURE", "SHUYONOTE_INDEX_APP_VERSION"],
  },
  {
    id: "external-package",
    group: "artifact",
    label: "外部插件包：应用真校验器验收",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib external_package -- --ignored --nocapture",
    requiresEnv: ["SHUYONOTE_PKG_ZIP", "SHUYONOTE_PKG_SIG", "SHUYONOTE_PKG_PUB"],
    incident: "打包从命令行 zip 换成库后字节布局变了：签名验过但解不开，只有装的时候才炸",
  },
  {
    id: "plugin-fragment-no-zip",
    group: "artifact",
    label: "打包工具不许依赖系统 zip",
    runner: "no-system-zip",
    incident: "曾经的 grep 门禁只写在 Linux CI 的 run 里；Windows 上没有命令行 zip，那边 `pnpm test` 红过三条",
  },
];

export const GROUP_ORDER = ["contract", "smoke", "sync", "plugin", "browser", "mobile", "rust", "artifact", "deploy"];

// 本地默认组：必须**只含纯 Node 门禁**——需要 Chromium / dev server / cargo 的组不进默认，
// 否则"一键本地验收"在没装浏览器的机器上直接红，很快就没人跑了。
// 这条不变量由 scripts/test-report.test.mjs 机器校验（不是靠这段注释）。
export const DEFAULT_GROUPS = ["contract", "smoke", "sync", "plugin"];

// 本地默认组允许出现的前缀/关键字：命令里出现 `cargo`、或名单里这些脚本即视为需要额外环境。
export const DEFAULT_GROUP_FORBIDDEN = [
  "cargo",
  "check-pdf-reload",
  "check-panel-layout",
  "check-web-build",
  "build:web",
  "verify-mobile-layout",
  "verify-mobile-overlays",
  "verify-mobile-views",
  "deploy", // 联网络判据：不许进一键本地验收 ✓
];

export function gateSetOf(list) {
  const byGroup = {};
  for (const gate of list) {
    (byGroup[gate.group] ||= []).push(gate.id);
  }
  for (const g of Object.keys(byGroup)) byGroup[g].sort();
  return byGroup;
}
