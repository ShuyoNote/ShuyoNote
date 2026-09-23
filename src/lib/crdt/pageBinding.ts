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
import * as Y from "yjs";
import {
  ensurePageCrdtState,
  markTextStale,
  readPageCrdtState,
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
  return state ? projectStateToJson(state) : storedJson;
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
export function mergeRemotePageState(
  db: ContentSql,
  pageId: string,
  remote: Uint8Array,
  now: number,
): MergedRemoteState {
  const mine = readPageCrdtState(db, pageId);
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
    return { adopted: false, state: mine, derivedStale: false, lineageConflict: conflict };
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
    writePageCrdtState(db, pageId, merged, now);
    if (changed) {
      // ★ S6 尾巴：**内容真的变了**才把投影写回（没变就一次写库都不做，免得制造假账）。
      writeContentProjection(db, pageId, projectStateToJson(merged));
      markTextStale(db, pageId);
    }
    return { adopted: false, state: merged, derivedStale: changed };
  } finally {
    session.dispose();
  }
}

// =====================================================================================
// S3b-2d：**端口版**绑定 —— 界面侧（`editor/Editor.tsx`）手里没有 `ContentSql`，只有 `api`
// （Web 走平台命令 `read_page_state` / `save_page_state`；桌面将来同理）⇒ 存取收成一个**端口**，
// 顺序逻辑（"先读、没有才建一次并立刻落盘"）仍然只写在**这一个文件**里，不在组件里重写一遍。
// =====================================================================================

/** 状态的**存取端口**。界面侧用 `lib/api` 实现即可（也就是那两条平台命令）。 */
export interface PageStatePort {
  read(pageId: string): Promise<Uint8Array | null>;
  save(pageId: string, state: Uint8Array): Promise<unknown>;
}

/** 端口版绑定：`persist` 是**异步**的（IPC/平台命令），**调用方必须处理失败**（不许静默）。 */
export interface AsyncPageBinding {
  session: PageSession;
  seeded: boolean;
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
export async function bindPageToEditorViaPort(opts: {
  port: PageStatePort;
  pageId: string;
  editor: LexicalEditor;
  seedJson: string;
  /** S9：claim 端口（不传 ⇒ 归一成 `unavailable` ⇒ 走"离线临时建"⇒ 与接线前**逐字相同**）。 */
  claim?: PageClaimPort;
  /** S9：本机 device id（claim 要带上；不传时只影响 claim，不影响其它）。 */
  deviceId?: string;
}): Promise<AsyncPageBinding> {
  const { port, pageId, editor, seedJson } = opts;
  const state = await port.read(pageId);
  if (state) {
    // ① 本地已有血统 ⇒ 载入。**不 claim、不重建**（这是 S1 红线那个入口）。
    const session = openPageSession({ state, editor });
    return {
      session,
      seeded: false,
      async persist() {
        await port.save(pageId, session.exportState());
      },
      dispose() {
        session.dispose();
      },
    };
  }

  // ②③④ 本地没有 ⇒ 走 S9 的决策（`bootstrap.ts`，四支都有判据）。
  const verdict = await claimVerdict(opts.claim, pageId, opts.deviceId ?? "");
  const decision = decideBootstrap({ hasLocalState: false, claim: verdict });
  if (decision.action === "wait-for-remote") {
    // ★ **不建**：这一页的首条血统属于别的设备。抛出去让调用方**如实报出来**（不静默建一条，
    //   也不静默变空页）—— 措辞要给用户看得懂的信息。
    throw new Error(
      "这一页的首条编辑历史属于另一台设备：等它同步下来再打开（本机这次**没有**新建血统）",
    );
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
