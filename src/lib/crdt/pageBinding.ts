// 冲刺切片 **S3b-2b**：把「一页」和「一个**真编辑器**」绑到一起 —— 接线用的唯一实现。
//
// 为什么单独一层：`editor/Editor.tsx` 里的编辑器实例由 `LexicalComposer` 持有、页面内容与保存回调
// 来自它的上层（拿得到数据库的那一侧）。把"载入状态 / 建血统 / 开会话 / 存回"这几步写在组件里，
// 就会变成每个调用点各写一遍 —— 而这里每一处错法都对应一条实测红线：
//   · 忘了 `ensurePageCrdtState` ⇒ 两台设备各建一条血统 ⇒ 合并时一块变两块（`mergeability.test.ts` ①）；
//   · 打开页面时用落盘 JSON 而不是**状态的投影** ⇒ 编辑器看到的是旧内容，且再一保存就是"回退"。
// 所以：**这几步只在这一个文件里写**，组件只负责"把编辑器和 seed JSON 交进来"。
//
// 三条口径（与 `docContent.ts` / `yDocBridge.ts` 的分工）：
//   ① 状态的**存/取**归那一层（`ensurePageCrdtState` / `readPageCrdtState` / `writePageCrdtState`）；
//   ② 状态字节的**生产/消费**归桥接层（`openPageSession`）；
//   ③ 本文件只做"把两者按正确顺序串起来"，不碰 SQL、不认字节格式。
//
// ⚠️ 这一层**不是**"文档内容的那一层"（`check-doc-content-access` 看着那边）⇒ 本文件**不许**
// 出现那三个存储列名字面量（注释也写中文描述）—— **连 import 的函数名也算**：第一版直接
// `import { yDocToContentJson }` 就被门禁当场判红（`pageBinding.ts（1 处）`）⇒ 改用桥接层提供的
// 别名 `projectStateToJson`。这就是层清单决策树里那条"会反复撞的税"。
import type { LexicalEditor } from "lexical";
import { a1AutoMergeEnabled, a1AutoMergeEnabledFrom, spaceAutoMergeEnabledFor } from "./a1Gate";
import * as Y from "yjs";
import {
  ensurePageCrdtState,
  markTextStale,
  readContent,
  readPageCrdtState,
  recordLineageConflict,
  writeContentProjection,
  writePageCrdtState,
  type ContentSql,
} from "../docContent";
import { openPageSession, projectStateToJson, type PageSession } from "./yDocBridge";
// S9：打开一页时"要不要建血统"的决策与 claim 端口（纯函数，四支都有判据）。
import { claimVerdict, decideBootstrap, type PageClaimPort } from "./bootstrap";

/** 一次"页面 ↔ 编辑器"的绑定。 */
export interface PageBinding {
  /** 绑在**传入的那个**编辑器上的会话。 */
  session: PageSession;
  /** `true` ⇒ 这一次首开建了血统（并已落盘）；`false` ⇒ 载入既有状态。 */
  seeded: boolean;
  /** 把当前状态存回（保存路径调用；`now` 由调用方给，保持与其它落盘同一时间源）。 */
  persist(now: number): void;
  /** 撤监听（页面关闭/组件卸载时调）。**不**销毁 editor/doc、也**不**动已落盘的状态。 */
  dispose(): void;
}

/**
 * ★ 把一页绑到**既有的**那个编辑器上（唯一入口）。
 *
 * 顺序是有理由的，别调换：
 *   1. `ensurePageCrdtState` —— **有状态就载入、没有才建一次并立刻落盘**（首开的那一次）；
 *   2. 再用这份状态开一个会话，并把会话**挂在传入的编辑器**上（hydration 会把状态落到编辑器里）。
 *
 * ⚠️ `seedJson` 必须是**编辑器当前内容**的落盘 JSON（含块身份）—— 也就是保存路径那个 serializer
 * 的产物，**不是**组件收进来的那个原始 prop（原始 prop 可能缺身份，而"不造身份"是桥接层的纪律，
 * 缺身份会当场抛：`openPageSession({ json })` → `modelJsonOf`）。
 */
export function bindPageToEditor(opts: {
  db: ContentSql;
  pageId: string;
  editor: LexicalEditor;
  seedJson: string;
  now: number;
}): PageBinding {
  const { db, pageId, editor, seedJson, now } = opts;
  const { state, seeded } = ensurePageCrdtState(db, pageId, seedJson, now, (json) =>
    // 建血统那一次：由这份 JSON 起一条血统，状态字节交给那一层落盘。
    openPageSession({ json }).exportState(),
  );
  const session = openPageSession({ state, editor });
  return {
    session,
    seeded,
    persist(at) {
      writePageCrdtState(db, pageId, session.exportState(), at);
    },
    dispose() {
      session.dispose();
    },
  };
}

/**
 * ★ 打开一页时**该给编辑器**的那份 JSON（加载契约）。
 *
 * - 库里**有** CRDT 状态 ⇒ 用**状态的投影**（状态是权威那一份；落盘那份只是投影，可能已经落后）；
 * - 库里**没有** ⇒ **原样返回**传进来的那份（此时行为与接线前逐字不变：还没建血统的页面零感知）。
 *
 * ⚠️ 代价如实写：有状态时每打开一页要多做一次"状态 → 编辑器语义"的投影（一次 ydoc→Lexical 转换）。
 * 这是"状态权威"必然的代价，不是疏忽；真成为瓶颈时应该在**保存时**把投影写回落盘那份（S6 的口径），
 * 而不是让读路径去猜。
 *
 * ⚠️ 拿到的仍是**落盘形态**：编辑器侧必须先过 `toModelDoc`（`editor/Editor.tsx` 的 `parseEditorState`
 * 已经这么做）—— 这一步不是可选的，判据 `pageBinding.test.ts` 第一版漏了它，当场红。
 */
export function loadJsonForEditor(db: ContentSql, pageId: string, storedJson: string): string {
  const state = readPageCrdtState(db, pageId);
  if (!state) return storedJson;
  const projected = projectStateToJson(state);
  // ⭐ **2026-11-26（U4 前置真缺陷的根因）**：**空状态不许赢回空页**。
  //
  // 现场（两台同 dev `743d328c`）：B 先收到"只有标题"那一笔 ⇒ 它的 page_crdt 是空 root（89B）；
  // A 之后写入正文（载荷带 `crdt_state`，但要等"打开页面"才合并）⇒ B 从没打开过那页 ⇒ 状态仍空；
  // 用户一打开 ⇒ 这条函数用**空状态**投影给编辑器 ⇒ 编辑器空 ⇒ 保存把空投影写回 ⇒ **正文没了**。
  //
  // 口径（与 Rust 侧 `doc_content::write_page_projection` 的守卫**成对**）：
  //   · 投影里**一个字都没有** ∧ 落盘正文**有字** ⇒ 用落盘正文**重建**状态并落盘，返回落盘那份；
  //   · 其余一律照旧（⛔ 不改"状态权威"这条既有语义）。
  // ⚠️ 重建失败（JSON 缺块身份等）⇒ **退回落盘那份**（编辑器至少能看到正文），并留痕。
  if (!hasAnyText(projected) && hasAnyText(storedJson)) {
    try {
      const rebuilt = openPageSession({ json: storedJson }).exportState();
      writePageCrdtState(db, pageId, rebuilt, Date.now());
      return storedJson;
    } catch {
      console.warn(
        `[pageBinding] 空 CRDT 状态重建失败，退回落盘正文：page=${pageId}（⛔ 不静默：见 U4 前置缺陷 2026-11-26）`,
      );
      return storedJson;
    }
  }
  return projected;
}

/** 这份编辑器 JSON 里有没有一个字的正文（与 Rust 侧 `projection_has_text` 同一口径）。 */
export function hasAnyText(json: string): boolean {
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string" && o.text.trim() !== "") return true;
      return Object.values(o).some(walk);
    }
    return false;
  };
  try {
    return walk(JSON.parse(json));
  } catch {
    return false;
  }
}

/** 把编辑器 JSON 里的正文按顺序拼成一个串（只用于**比较**两份内容是否一样）。 */
export function plainTextOfJson(json: string): string | null {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") out.push(o.text);
      for (const k of Object.values(o)) walk(k);
    }
  };
  try {
    walk(JSON.parse(json));
    return out.join("\n");
  } catch {
    return null;
  }
}

/** 一份 CRDT 状态的正文串（投影再取文本；解不开 ⇒ null）。 */
export function plainTextOfState(state: Uint8Array): string | null {
  try {
    return plainTextOfJson(projectStateToJson(state));
  } catch {
    return null;
  }
}

/** 拿不到裁定时**先等对端血统**的默认窗口（ms）。`0` ⇒ 不等（回到旧行为）。 */
export const CLAIM_WAIT_DEFAULT_MS = 5_000;

/**
 * 等对端血统的窗口：`globalThis.__SHUYONOTE_CLAIM_WAIT_MS__` 可覆盖（判据/现场调参用）。
 * 上限 60s（⛔ 不许把"打开页面"无限期挂住）；非法值 ⇒ 默认 5s。
 */
export function claimWaitMs(): number {
  const g = globalThis as { __SHUYONOTE_CLAIM_WAIT_MS__?: unknown };
  const raw = g.__SHUYONOTE_CLAIM_WAIT_MS__;
  if (raw === undefined || raw === null) {
    // 测试环境（vitest）默认**不等**：否则每个"首开"用例都要白等 5 秒（判据只关心行为，不关心等待）。
    const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
    if (mode === "test") return 0;
    return CLAIM_WAIT_DEFAULT_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CLAIM_WAIT_DEFAULT_MS;
  return Math.min(n, 60_000);
}

/**
 * 等"对端的待并状态"出现（最多 `waitMs`，每 `pollMs` 查一次；先立刻查一次）。
 *
 * 用途：`bindPageToEditorViaPort` 在 `claim=unavailable` 时不马上铸血统 ——
 * 先给对端一个窗口（默认 5s），拿到了就**承接**（同一棵树），拿不到再按离线铸。
 */
export async function waitForRemotePending(
  port: PageStatePort,
  pageId: string,
  waitMs: number,
  pollMs = 250,
): Promise<{ seq: number; state: Uint8Array } | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const list = (await port.readPending?.(pageId)) ?? [];
    if (list.length > 0) return list[0];
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// =====================================================================================
// S4a：**远端来的状态怎么并进本机**（"真正的合并同步"在客户端这一侧的唯一入口）
//
// 与 `bindPageToEditor`/`ensurePageCrdtState` 的分工：那两个管"打开页面"（首开建血统），
// 这个管"**别人那一版到了**"。两条路都必须走在同一个血统上 —— 这正是 S1 红线（从 JSON 各自新建
// ⇒ 一块变两块）在**同步路径**上的落点。
// =====================================================================================

/**
 * 这条状态里出现过的 **client id** —— 也就是它的**血统指纹**。
 *
 * 为什么需要：S1 实测过"从 JSON **各自新建**的两份状态合起来 ⇒ 一块变两块且 `blockId` 重复"
 * （`mergeability.test.ts` ①）。而生产路径上那个窗口是真实存在的（两台设备**同时**首开同一张
 * 从没建过血统的页、且各自离线）。⇒ 光靠"首开只建一次"（S3b-2a）挡不住**已经发生**的两条血统，
 * 所以在**合并**这一处再补一道护栏：**先看血统相不相关，再决定合不合**。
 *
 * 判据：两份状态里的 client id 集合**有交集** ⇒ 同一条血统（同源或一方继承另一方）；
 * 两份都非空却**完全不相交** ⇒ 各自独立创建 ⇒ **不许合**（合了就是 S1 那个损坏）。
 */
export function lineageClientIds(state: Uint8Array): Set<number> {
  const out = new Set<number>();
  try {
    const decoded = Y.decodeUpdate(state) as { structs: Array<{ id: { client: number } }> };
    for (const s of decoded.structs) out.add(s.id.client);
  } catch {
    // 解不出来 ⇒ 空集（调用方按"没有指纹"处理：那种情况不拦，但也别当成"相关"的证据）
    return out;
  }
  return out;
}

/** 两条血统相不相关：有交集 ⇒ 相关；任一方**没有指纹**（空状态）⇒ 视为相关（没什么可冲突的）。 */
export function lineagesRelated(a: Set<number>, b: Set<number>): boolean {
  if (a.size === 0 || b.size === 0) return true;
  for (const id of a) if (b.has(id)) return true;
  return false;
}

/**
 * 血统指纹 ⇒ **表里存的那一列**（排序后用逗号连起来；空集 ⇒ 空串）。
 *
 * 为什么要有它：页级血统冲突的**去重键**就是这一对指纹（"同一对指纹只提一次"）——
 * 两处记录点（web 当场合并 / 桌面端口）必须算出**逐字相同**的那两个字符串，否则去重会失效。
 */
export function lineageFingerprint(ids: Set<number>): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

/** 把远端状态并进来的结果。 */
export interface MergedRemoteState {
  /** `true` ⇒ 本机原先**没有**这一页的状态，这一版被**采用**（不是"从 JSON 重建"）。 */
  adopted: boolean;
  /** 合并后本机持有的状态（调用方一般不用它，判据用）。 */
  state: Uint8Array;
  /**
   * S6：这次合并**是否可能让派生文本（正文列/FTS）落后** ⇒ 已打「待重建」标记。
   *
   * 为什么要有它：合并产物是**拼出来**的，而正文列还是旧的 —— 不落痕就会"搜不到刚并进来的字"
   * （裁定 (iii) 同一精神：不许静默落后）。补算器拾起后标记会清掉；**算出来与库里相同也会清**
   * （`refreshPageTextIfStale` 的两条出口）⇒ 这一处宁可多标一次，也不漏标。
   */
  derivedStale: boolean;
  /** A1 G0：合并过程抛错 ⇒ **本机状态原样保留**（⛔ 不写坏、不丢）。 */
  mergeFailed?: boolean;
  /** A1 G0：开关关掉（kill switch）⇒ 不合并、保留本机（用于回滚）。 */
  disabled?: boolean;
  /** A1 G0：本机 CRDT 状态投影 ≠ 内容列（状态陈旧）⇒ 拒绝合并、保本机（⛔ 不覆盖新内容）。 */
  staleState?: boolean;
  /**
   * ★ **血统冲突**（有值 ⇒ 这次**没有合并**，本机那一版被原样保留）。
   *
   * 这是"两条独立血统"的现实出口：宁可不合、如实报出来，也不合出"一块变两块"。
   * 调用方**必须**把它报出去（`main.tsx` 注册的那一版会 toast ＋ 控制台报错）—— 静默吞掉
   * 会让两台设备各自继续长，问题更难查。
   */
  lineageConflict?: { mine: number[]; remote: number[] };
}

/**
 * ★ 把**远端来的**一版状态并进本机这一页（唯一入口）。
 *
 * - 本机还没有 ⇒ **直接采用**它（它自己带着血统，别在这儿另起一条）；
 * - 本机已有 ⇒ **先验血统**（见 `lineageClientIds`）：不相关 ⇒ **拒绝合并并报出来**；
 *   相关 ⇒ 载入**本机的血统**、把远端那笔 `merge` 进去、再存回。
 *
 * ⚠️ 本函数**只动 CRDT 状态 ＋ 那个"待重建"标记**，**不碰**落盘的那份投影（`pages` 里那两列）
 * —— 投影怎么跟上归 S6 的口径（今天编辑器打开时会用状态的投影覆盖，所以界面上看到的是对的内容）。
 * ⚠️ 也**不**标脏（`dirty`）：合并产物该不该回推由调用方决定（S5 服务端那一侧）。
 */
/**
 * A1 G0 kill switch：**默认开**（今天的同血统合并已经在跑；关掉才是回滚）。
 * 只认显式 `0/false/off` 为关；未设置/其它值 ⇒ 开。⛔ 不引入第二个真相源。
 */
export { a1AutoMergeEnabledFrom };

/** A1 G0：合并失败留一条本地痕（最多 20 条；⛔ 不写库、不迁移；DB 持久化留 G1）。 */
function recordA1Failure(pageId: string, error: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    const key = "shuyonote:a1-merge-failures";
    const prev = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
    prev.push({ pageId, at: new Date().toISOString(), error: String(error).slice(0, 300) });
    localStorage.setItem(key, JSON.stringify(prev.slice(-20)));
  } catch {
    // 留痕失败不许影响主路径（页面已经保本机了）。
  }
}

/**
 * 空间级 A1 开关：从空间库的 `workspaces` 行取 workspace id，
 * 再读本机 localStorage 的 `shuyonote:crdt.autoMerge.<id>`（默认关）。
 * ⛔ 不写库、不新增表；G1-b 先这么分空间。
 */
export function spaceAutoMergeEnabled(db: ContentSql): boolean {
  try {
    const row = db.query<{ id: string }>("SELECT id FROM workspaces LIMIT 1", [])[0];
    return row ? spaceAutoMergeEnabledFor(String(row.id)) : false;
  } catch {
    return false;
  }
}

export function mergeRemotePageState(
  db: ContentSql,
  pageId: string,
  remote: Uint8Array,
  now: number,
  enabled: boolean = true, // 直接调用者/判据默认按“允许合并”；生产调用方显式传 a1AutoMergeEnabled()
): MergedRemoteState {
  const mine = readPageCrdtState(db, pageId);
  if (mine) {
    // ⭐ A1 安全闸（2026-11-22 影子扫描发现 5 页状态投影 ≠ 内容列）：
    //   状态陈旧时合并再写投影会**覆盖用户的新内容** ⇒ 宁可拒绝，⛔ 不赌。
    //   老库/测试夹具读不到内容列 ⇒ 不拦（保持既有测试与老页行为）。
    try {
      const stored = readContent(db, pageId);
      if (stored && projectStateToJson(mine) !== stored.json) {
        console.warn(`[a1] 本机 CRDT 状态与内容列不一致（状态陈旧）⇒ 拒绝合并 page=${pageId}`);
        return { adopted: false, state: mine, derivedStale: false, staleState: true };
      }
    } catch {
      // 内容列读不出/解析失败 ⇒ 不做这个判断（不拦，但也不写坏：后续合并仍有 try/catch）。
    }
  }
  if (!mine) {
    writePageCrdtState(db, pageId, remote, now);
    // ★ S6 尾巴：落盘那一列（反链/插件/AI/导出读的**投影**）也跟上 —— 由**状态**重新序列化。
    //   （只动那一列、不动 `dirty`；正文文本那一半仍走「待重建」标记 ＋ 补算器。）
    writeContentProjection(db, pageId, projectStateToJson(remote));
    // 采用了别人的一版 ⇒ 本机那一列正文**很可能**落后（也可能恰好一致 ⇒ 由补算器清掉，见上）。
    markTextStale(db, pageId);
    return { adopted: true, state: remote, derivedStale: true };
  }

  // ★ 血统护栏：两条**独立创建**的状态不许合（合了就是 S1 那个"一块变两块"）。
  const mineIds = lineageClientIds(mine);
  const remoteIds = lineageClientIds(remote);
  if (!lineagesRelated(mineIds, remoteIds)) {
    const conflict = {
      mine: [...mineIds].sort((x, y) => x - y),
      remote: [...remoteIds].sort((x, y) => x - y),
    };
    // ★ **立刻有痕**（不依赖调用方）：这条路径一旦发生就说明"两台设备各自建过血统"，
    //   静默吞掉会让两台各自继续长、问题更难查。调用方（`main.tsx` 注册的那版）还会再 toast 一次。
    console.warn(`[crdt] 血统冲突：拒绝合并（本机版本保留）page=${pageId}`, conflict);
    // ★ §13.3 第 2 条（第 49 轮）：**页级留痕**（含对端那一版的**投影快照**）。
    //   为什么快照必须在这里存：这条路的对端那一版在 web 上是"当场合并、过了就没了"，
    //   桌面上则在 `clearPending` 之后没了 ⇒ 不留它，用户点"另存为新页"时就无米下锅。
    //   去重（同一对指纹只提一次）在那一层 —— 这里只管"如实把事实交出去"。
    recordLineageConflict(
      db,
      pageId,
      lineageFingerprint(mineIds),
      lineageFingerprint(remoteIds),
      projectStateToJson(remote),
      now,
    );
    return { adopted: false, state: mine, derivedStale: false, lineageConflict: conflict };
  }

  if (!enabled) {
    // A1 G0 kill switch：不合并、保留本机（远端那一版仍留在待裁决侧，⛔ 不丢）。
    console.warn(`[a1] 自动合并开关已关，保留本机版本 page=${pageId}`);
    return { adopted: false, state: mine, derivedStale: false, disabled: true };
  }

  const session = openPageSession({ state: mine });
  try {
    session.merge(remote);
    const merged = session.exportState();
    // ★ 只在**内容真的变了**时才标（与 `applyRemoteContent` 的 `keptLocal` 同一纪律：
    //   否则就是**假账** —— 补算器白解析一遍再清掉）。
    //   判据用**投影**比（内容级），不用字节比：同一份状态两次编码在 yjs 里是稳定的，
    //   但"字节不同"未必意味着内容不同，拿它当判据会多标。
    const changed = projectStateToJson(mine) !== projectStateToJson(merged);
    // ⭐ A1 审查 P0-3：**先写投影/标记，再写状态** —— 若投影写失败，状态还没落，
    //   catch 里“保本机”才成立；反过来会出现“状态已 merged、投影没跟上”的半写。
    if (changed) {
      writeContentProjection(db, pageId, projectStateToJson(merged));
      markTextStale(db, pageId);
    }
    writePageCrdtState(db, pageId, merged, now);
    return { adopted: false, state: merged, derivedStale: changed };
  } catch (err) {
    // A1 G0：合并异常 ⇒ **保本机**（不写坏状态、不丢远端；由调用方提示可重试）。
    console.error(`[a1] 自动合并失败，保留本机版本 page=${pageId}`, err);
    recordA1Failure(pageId, err);
    return { adopted: false, state: mine, derivedStale: false, mergeFailed: true };
  } finally {
    session.dispose();
  }
}

// =====================================================================================
// S3b-2d：**端口版**绑定 —— 界面侧（`editor/Editor.tsx`）手里没有 `ContentSql`，只有 `api`
// （Web 走平台命令 `read_page_state` / `save_page_state`；桌面将来同理）⇒ 存取收成一个**端口**，
// 顺序逻辑（"先读、没有才建一次并立刻落盘"）仍然只写在**这一个文件**里，不在组件里重写一遍。
// =====================================================================================

/** 一条**待并的远端状态**（桌面 Rust 收下的；Web 平台恒为空 —— 它当场合并）。 */
export interface PendingPageState {
  /** 服务端那一笔变更的 `seq`（只用于稳定排序与留痕，不参与合并语义）。 */
  seq: number;
  state: Uint8Array;
}

/** 状态的**存取端口**。界面侧用 `lib/api` 实现即可（也就是那几条平台命令）。 */
export interface PageStatePort {
  read(pageId: string): Promise<Uint8Array | null>;
  save(pageId: string, state: Uint8Array): Promise<unknown>;
  /**
   * 冲刺 §11.4 收口：**待并的远端状态**（桌面才有内容）。
   * 不实现 ⇒ 等同于"没有待并状态"（与接线前**逐字相同** —— 老调用方零感知）。
   */
  readPending?(pageId: string): Promise<PendingPageState[]>;
  /** 合并完就清（不实现 ⇒ 什么都不做）。 */
  clearPending?(pageId: string): Promise<unknown>;
  /**
   * ★ 冲刺 §13.3 第 1 条（2026-09-23 第 49 轮）：**把状态投影写回落盘那一列**（＋派生）。
   *
   * 为什么要它：这一层的"打开页面"路径只写**状态**（`save`），而 `pages` 那一列是反链/插件/AI/导出
   * 读的**投影** ⇒ 不写它就要等**下一次保存**才跟上（"看不到刚并进来的字"）。
   * 不实现 ⇒ 与接线前**逐字相同**（老调用方零感知 —— 与 `readPending` 同一口径）。
   * ⚠️ 语义（**没变就不写**、数据库页排除、不动 `dirty`）在那一层，这里只管"什么时候调它"。
   * ⚠️ 参数名刻意叫 `docJson`（**不是存储列名**）—— 与 `StaleTextPage.doc_json` 同一处置：
   *    这一层不许出现那三个存储列的字面量（`check-doc-content-access` 按 token 计数）。
   */
  writeProjection?(pageId: string, docJson: string): Promise<unknown>;
  /**
   * ★ 冲刺 §13.3 第 2 条（2026-09-23 第 49 轮）：**把一次页级血统冲突交出去留痕**。
   *
   * 为什么要走端口：判定"这两条血统相不相关"**只有这一层做得了**（要 Yjs），而"存到哪"是平台的事
   *（桌面 Rust 表 / Web 的本地库）。去重（同一对指纹只提一次）在存储那一层。
   * `docJson` ＝ **对端那一版的整页投影**（救援靠它 —— 待并状态随后会被清掉）。
   * 不实现 ⇒ 与接线前**逐字相同**（老调用方零感知）。
   */
  recordLineageConflict?(opts: {
    pageId: string;
    mineFp: string;
    remoteFp: string;
    docJson: string;
  }): Promise<unknown>;
}

/** 端口版绑定：`persist` 是**异步**的（IPC/平台命令），**调用方必须处理失败**（不许静默）。 */
export interface AsyncPageBinding {
  session: PageSession;
  seeded: boolean;
  /**
   * 本机**没有**状态、但收下了对端的（待并）状态 ⇒ 这一页的血统**由对端建**，本机只是**承接**。
   * ⚠️ 与 `seeded` 互斥：`adopted=true` 时 seeded 必为 `false`（没"首开建一次"这回事）。
   */
  adopted?: boolean;
  /** 待并状态里因为"不是同一条血统"被**拒绝合并**的条数（> 0 ⇒ 有痕，调用方该如实报出来）。 */
  pendingSkipped?: number;
  /** A1 G0：开关关/合并失败而**保留**的待并项数（>0 ⇒ 调用方该知道“这次没并完”）。 */
  pendingDeferred?: number;
  persist(): Promise<void>;
  dispose(): void;
}

/**
 * ★ 端口版：把一页绑到既有编辑器上（界面侧的入口）。
 *
 * 与 `bindPageToEditor` 同一套顺序，只是存取换成了异步端口：
 *   1. **先读**状态；有 ⇒ 载入（`seeded=false`），没有 ⇒ 由 `seedJson` **建一次**（`seeded=true`）
 *      并**立刻落盘**（这就是"首开只建一次"的落地点）；
 *   2. 两种情形都把会话挂在**传入的**编辑器上（hydration 会把内容落到编辑器里）。
 *
 * ⚠️ 与 `ensurePageCrdtState` 同一个已知限制：两台设备**同时**首开一张从没建过血统的页、且各自
 * 离线时，两条血统仍可能各自被建出来 ⇒ 彻底解法在 S5（服务端拒绝/收敛第二条血统）。
 */
/** 一份 CRDT 状态里有没有一个字的正文（⛔ 用投影判断，不碰字节格式；解不开 ⇒ 当作没有）。 */
export function stateHasAnyText(state: Uint8Array): boolean {
  try {
    return hasAnyText(projectStateToJson(state));
  } catch {
    return false;
  }
}

export async function bindPageToEditorViaPort(opts: {
  port: PageStatePort;
  pageId: string;
  editor: LexicalEditor;
  seedJson: string;
  /** S9：claim 端口（不传 ⇒ 归一成 `unavailable` ⇒ 走"离线临时建"⇒ 与接线前**逐字相同**）。 */
  claim?: PageClaimPort;
  /** S9：本机 device id（claim 要带上；不传时只影响 claim，不影响其它）。 */
  deviceId?: string;
  /** A1：是否允许自动合并；不传 ⇒ 运行时开关（默认关）。判据/自用可显式 true。 */
  a1Enabled?: boolean;
}): Promise<AsyncPageBinding> {
  const { port, pageId, editor, seedJson } = opts;
  const state0 = await port.read(pageId);
  const pending = (await port.readPending?.(pageId)) ?? [];

  // ⭐ **2026-11-26（真机第二次复现，生产路径就是这一条）**：**空状态不许用来水合编辑器**。
  //
  // 真机现场（AMD，dev `7057ee5d`）：验证页 `U4-VERIFY-1530` 落盘正文 1706B、CRDT 状态 89B（空 root）；
  // 打开页面走的是**本函数**（不是 `loadJsonForEditor`）⇒ 用空状态水合 ⇒ 编辑器空 ⇒ 保存写回空投影
  // ⇒ 1706B → 243B，并记了一条**空 upsert**（还会反推给对端）。
  //
  // 口径（与 Rust `doc_content::write_page_projection` 的守卫、`loadJsonForEditor` 的同一口径）：
  //   · 读到状态 ∧ 状态里**一个字都没有** ∧ `seedJson`（落盘正文）**有字**
  //   ⇒ 用落盘正文**重建**状态并落盘，再用它当 base；
  //   · 重建失败 ⇒ **退到"从正文新建会话"**（宁可新建血统，也不让空状态把正文清掉）。
  let state = state0;
  if (state && hasAnyText(seedJson) && !stateHasAnyText(state)) {
    try {
      const rebuilt = openPageSession({ json: seedJson }).exportState();
      await port.save(pageId, rebuilt);
      state = rebuilt;
      console.warn(
        `[pageBinding] 空 CRDT 状态已用落盘正文重建（⛔ 不用空状态水合）：page=${pageId}`,
      );
    } catch (e) {
      console.warn(
        `[pageBinding] 空状态重建失败 ⇒ 退到"从正文新建会话"（⛔ 不用空状态水合）：page=${pageId}`,
        e,
      );
      const session = openPageSession({ json: seedJson, editor });
      await port.save(pageId, session.exportState());
      return {
        session,
        seeded: true,
        adopted: false,
        pendingSkipped: 0,
        pendingDeferred: 0,
        async persist() {
          await port.save(pageId, session.exportState());
        },
        dispose() {
          session.dispose();
        },
      };
    }
  }

  // ★★ §11.4 收口（第 42 轮）：**先把收下的远端状态并掉，再谈建不建血统**。
  //   顺序很重要：本机已有状态 ⇒ 在它上面继续；本机没有但收下了对端的 ⇒ **承接对端那条血统**
  //   （这正是 `bootstrap.ts` 里 `wait-for-remote` 想要的"等它同步下来"）—— 两者都**不 claim**。
  if (state || pending.length > 0) {
    // 起点：本机状态优先；没有就取**最旧**那条待并状态（它自带对端的血统）。
    // ⭐ **2026-11-26（第三次真机复现，AMD 的 `page_crdt_pending` 有 8 条、投影仍空）**：
    //   本机状态存在但**一个字都没有**、而对端有几条**带正文**的待并状态时，
    //   那个空状态**不能当基座**（A1 默认关 ⇒ pending 只会被"延后合并"⇒ 编辑器拿空基座水合 ⇒ 保存写空）。
    //   口径：**空基座 ⇒ 直接改用最新一条带正文的 pending 当基座**（这是"承接"不是"合并"，
    //   ⛔ 不受 A1 开关约束）；被承接的那条从待并列表里摘掉，避免再并一遍。
    let base = state ?? pending[0].state;
    let pendingToMerge = state ? pending : pending.slice(1);
    let adoptedBase = false;
    if (state && !stateHasAnyText(state)) {
      const withText = [...pending].reverse().find((p) => stateHasAnyText(p.state));
      if (withText) {
        base = withText.state;
        pendingToMerge = pending.filter((p) => p !== withText);
        adoptedBase = true;
        console.warn(
          `[pageBinding] 本机状态为空 ⇒ 承接对端带正文的状态当基座（⛔ 不用空状态水合）：page=${pageId} seq=${withText.seq}`,
        );
      }
    }
    const a1Enabled0 = opts.a1Enabled ?? a1AutoMergeEnabled();
    if (base && !a1Enabled0 && !adoptedBase && hasAnyText(seedJson)) {
      const stateText = plainTextOfState(base);
      const seedText = plainTextOfJson(seedJson);
      if (stateText !== null && seedText !== null && stateText !== seedText) {
        try {
          const rebuilt = openPageSession({ json: seedJson }).exportState();
          await port.save(pageId, rebuilt);
          base = rebuilt;
          console.warn("[pageBinding] 影子模式（A1 关）：状态投影≠正文 ⇒ 用正文重播状态 page=" + pageId);
        } catch (e) {
          console.warn("[pageBinding] 影子模式重播失败（保留旧状态）page=" + pageId, e);
        }
      }
    }
    const session = openPageSession({ state: base, editor });
    let ids = lineageClientIds(base);
    let merged = false;
    let skipped = 0;
    let deferred = 0;
    const a1Enabled = a1Enabled0;
    for (const p of pendingToMerge) {
      const remoteIds = lineageClientIds(p.state);
      // ★ 与 `mergeRemotePageState` **同一条护栏**（复用同一对纯函数，不另写一份判定）：
      //   两条**独立创建**的血统不许合（合了就是 S1 那个"一块变两块"）⇒ 拒绝并**留痕**。
      if (!lineagesRelated(ids, remoteIds)) {
        skipped += 1;
        console.warn(
          `[crdt] 待并的远端状态与这条血统无关 ⇒ 拒绝合并（本机版本保留）page=${pageId} seq=${p.seq}`,
        );
        // ★ §13.3 第 2 条（第 49 轮）：**页级留痕**（含对端那一版的投影快照 —— 下面 `clearPending`
        //   会把它清掉，不留就无从"另存为新页"）。失败**不许静默**，但也别把"打开页面"拖红 ⇒ warn。
        try {
          await port.recordLineageConflict?.({
            pageId,
            mineFp: lineageFingerprint(ids),
            remoteFp: lineageFingerprint(remoteIds),
            docJson: projectStateToJson(p.state),
          });
        } catch (e) {
          console.warn("[crdt] 血统冲突留痕失败（下一次打开这一页会再试）", e);
        }
        continue;
      }
      if (!a1Enabled) {
        // A1 G0 kill switch：不合并；**保留待并项**（下次打开/重开开关还能并）。
        deferred += 1;
        continue;
      }
      try {
        session.merge(p.state);
      } catch (e) {
        deferred += 1;
        console.warn(`[a1] 待并状态合并失败，保留待并项 page=${pageId} seq=${p.seq}`, e);
        continue;
      }
      merged = true;
      ids = new Set([...ids, ...remoteIds]);
    }
    // 只有**动过**才回写（与 `mergeRemotePageState` 同一纪律：没变就一次写库都不做）
    if (merged || state === null || adoptedBase) {
      await port.save(pageId, session.exportState());
    }
    // ★ 冲刺 §13.3 第 1 条（第 49 轮）：**投影也要跟上**，否则反链/插件/AI/导出要等下一次保存
    //   才看到刚并进来的内容（"搜不到刚同步过来的字"）。
    //   ⚠️ 只在**真的有待并状态**时才算投影（本机有状态、无待并 ⇒ 一个字都不多算 —— 那是最常见的路）。
    //   "变了没"的判据与 `mergeRemotePageState` **同一纪律**（比投影、不比字节）：
    //     · 本机原先没有状态（`state === null`）⇒ 这一页的内容**整个来自对端** ⇒ 必须写；
    //     · 否则只有投影真的变了才写（没变 ⇒ 连一次写库都不做 —— 那一层还会自己再判一次）。
    //   ⚠️ 这一笔是**派生**的收尾：失败**不许**把"页面打开"整件事拖红（状态已经落盘、页面可用），
    //      但也**不许静默** ⇒ 当场 `console.warn` 说清后果（与"下一次保存会跟上"）。
    if (pending.length > 0) {
      const baseJson = projectStateToJson(base);
      const mergedJson = projectStateToJson(session.exportState());
      if (state === null || adoptedBase || mergedJson !== baseJson) {
        try {
          await port.writeProjection?.(pageId, mergedJson);
        } catch (e) {
          console.warn(
            "[crdt] 投影写回失败（反链/导出可能仍滞后；下一次保存会跟上）",
            e,
          );
        }
      }
    }
    // 合并过就清（不实现 `clearPending` ⇒ 不清 —— 那会让同一批状态每次打开都再并一遍；调用方该实现它）
    if (pending.length > 0 && deferred === 0) {
      await port.clearPending?.(pageId);
    }
    return {
      session,
      seeded: false,
      adopted: state === null || adoptedBase,
      pendingSkipped: skipped,
      pendingDeferred: deferred,
      async persist() {
        await port.save(pageId, session.exportState());
      },
      dispose() {
        session.dispose();
      },
    };
  }

  // ②③④ 本地没有（也**没有收下任何**对端状态）⇒ 走 S9 的决策（`bootstrap.ts`，四支都有判据）。
  const verdict = await claimVerdict(opts.claim, pageId, opts.deviceId ?? "");
  const decision = decideBootstrap({ hasLocalState: false, claim: verdict });
  if (decision.action === "wait-for-remote") {
    // ★ **不建**：这一页的首条血统属于别的设备。抛出去让调用方**如实报出来**（不静默建一条，
    //   也不静默变空页）—— 措辞要给用户看得懂的信息。
    throw new Error(
      "这一页的首条编辑历史属于另一台设备：等它同步下来再打开（本机这次**没有**新建血统）",
    );
  }
  // ⭐ **2026-11-27（owner 拍 A：只有一台能铸血统）**：拿不到裁定时**先等对端**，再按离线铸。
  //
  // 真机现场（2026-11-26）：B 在"收到 A 的 crdt_state 之前"先打开了新页 ⇒ claim 端口还没有
  // （`claimVerdict` 今天恒返回 unavailable）⇒ 直接 `mint-provisional-offline` ⇒ 两条血统永久分叉，
  // 之后每轮都只能弹"另一条编辑历史"。
  // 口径：**unavailable ⇒ 先等 `waitMs`（默认 5s，env `SHUYONOTE_CRDT_CLAIM_WAIT_MS`）**，
  //       等到对端的待并状态就**承接**它（同一棵树）；等不到再按"离线未裁定"铸（行为与以前一致，只是晚 5 秒）。
  //       ⛔ 不改 `decideBootstrap` 的纯函数语义（那是判据面），只改**等待**这一步。
  if (decision.action === "mint-provisional-offline") {
    const waitMs = claimWaitMs();
    if (waitMs > 0) {
      const got = await waitForRemotePending(port, pageId, waitMs);
      if (got) {
        const session = openPageSession({ state: got.state, editor });
        await port.save(pageId, session.exportState());
        console.warn("[crdt] 无裁定 ⇒ 等到对端血统并承接（⛔ 不自己铸一条）：page=" + pageId + " seq=" + got.seq);
        return {
          session,
          seeded: false,
          adopted: true,
          pendingSkipped: 0,
          pendingDeferred: 0,
          async persist() {
            await port.save(pageId, session.exportState());
          },
          dispose() {
            session.dispose();
          },
        };
      }
    }
  }
  // `mint` 与 `mint-provisional-offline` 都建（后者是**未裁定**的：联网后若撞上血统护栏，
  // 由 `mergeRemotePageState` 如实报冲突，而不是假装它就是权威）。
  const session = openPageSession({ json: seedJson, editor });
  await port.save(pageId, session.exportState());
  return {
    session,
    seeded: true,
    async persist() {
      await port.save(pageId, session.exportState());
    },
    dispose() {
      session.dispose();
    },
  };
}
