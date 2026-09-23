// `content_json` ⇄ `ydoc` 的**唯一实现**（阶段 2 · Slice A，2026-09-23）。
//
// ## 它是什么 / 不是什么
// - 是：把**落盘形态**的 `content_json` 换成 yjs 的 update 字节、再换回来的一对纯函数
//   ＋「一步往返」的壳。判据在 `yDocBridge.test.ts`。
// - **不是**：没有改任何持久化形态、没有加同步字段、没有碰服务端、没有碰插件契约
//   —— 见 `docs/plans/2026-09-23-crdt-stage2-kickoff.md` 的 Slice A 边界。
//
// ## 两处必须复用应用既有实现（尖刺 §6 点名要求，不许另写一套）
// 1. **空页归一**：`lexicalStateValid`（`"{}"`／无 root ⇒ 规范空页；不可解析 ⇒ null）。
//    尖刺实测：真空 root 直接 `parseEditorState` 会抛，而 `"{}"` 正是应用的默认值
//    （`spike/crdt/README.md` §1.4①）⇒ 这条路**必须**先过它。
// 2. **块身份两形态**：内存/CRDT 平面用新 type（`shuyo-paragraph` ＋ **声明字段** `blockId`），
//    落盘/同步仍用老形态。转换因此是 `toModelDoc` →（yjs）→ `toLegacyDoc`，
//    而不是"直接把磁盘 JSON 丢给 yjs"——尖刺实测后者会把 `blockId` 丢掉（§1.2，块引用会断）。
//
// ## 做法来自哪
// 尖刺的问题一脚本（`spike/crdt @ 71a3e1db` 的 `q1-roundtrip.mjs`，分支已归档成文档）：
// headless Lexical ＋ 真 `@lexical/yjs` 的 **V2** 三件套
// （`createBindingV2__EXPERIMENTAL` / `syncLexicalUpdateToYjsV2__EXPERIMENTAL` /
// `syncYjsStateToLexicalV2__EXPERIMENTAL`），**不碰浏览器** ⇒ Windows 也能自验。
// 依赖 `yjs@13.6.32` / `@lexical/yjs@0.50.0`（与 `lexical@0.50` 同源）钉死在 **devDependencies**，
// 不进打包产物。
import * as Y from "yjs";
import { createEditor, type LexicalEditor } from "lexical";
import {
  createBindingV2__EXPERIMENTAL,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsStateToLexicalV2__EXPERIMENTAL,
} from "@lexical/yjs";
import { EDITOR_NODES } from "../../editor/config";
import { toLegacyDoc, toModelDoc } from "../blockIdentity";
import { lexicalStateValid } from "../lexicalValidate";

/** V2 的根：**不带 `nodeName`** 的 `XmlElement`（与 `@lexical/yjs` 的 V2 绑定约定一致）。 */
const ROOT_KEY_V2 = "root-v2";
/** binding 的 key，只影响 yjs 侧的顶层命名（与契约无关）。 */
const BINDING_KEY = "main";
/** yjs 的 shared type 名（一页一份 doc）。 */
const DOC_NAME = "shuyonote-page";

/**
 * 空页的**规范形态**：`children` 里恰好**一个空段落**（不是空 root —— 空 root 会被
 * `setEditorState` 当场拒绝，见 `modelJsonOf`）。段落带一个**稳定** id，理由同那里。
 */
const EMPTY_PAGE_MODEL_JSON = JSON.stringify({
  root: {
    type: "root",
    version: 1,
    direction: "ltr",
    format: "",
    indent: 0,
    children: [
      {
        type: "shuyo-paragraph",
        version: 1,
        direction: null,
        format: "",
        indent: 0,
        textFormat: 0,
        textStyle: "",
        blockId: "empty-page",
        children: [],
      },
    ],
  },
});

type SyncProvider = Parameters<typeof syncLexicalUpdateToYjsV2__EXPERIMENTAL>[1];

/** 只有 awareness 会被 `syncCursorPositions` 用到；往返不需要真 awareness（尖刺同款桩）。 */
function providerStub(): SyncProvider {
  return {
    awareness: {
      getStates: () => new Map(),
      getLocalState: () => null,
      setLocalState: () => {},
      on: () => {},
      off: () => {},
    },
  } as unknown as SyncProvider;
}

function newEditor(): LexicalEditor {
  return createEditor({ nodes: EDITOR_NODES, namespace: "shuyonote-crdt" });
}

/** 归一 + 升到模型形态；不可解析 ⇒ 抛（**不静默**）。 */
function modelJsonOf(contentJson: string): string {
  const normalized = lexicalStateValid(contentJson);
  if (normalized === null) {
    throw new Error("contentJsonToYDoc: 不是可解析的 Lexical JSON（lexicalStateValid 返回 null）");
  }
  // ★ 空页要变成**一个空段落**，不能是"空 root"：`lexicalStateValid` 对 `{}`/无 root 回的是
  //   `children: []` 的规范空页，而 `setEditorState` 见到空 root 会**当场抛**
  //   （`the editor state is empty`）—— 尖刺 §1.4① 实测过这一条，并且写明"空页的规范形态是一个空段落"。
  //   ⚠️ 这里给那一段一个**稳定** id（`empty-page`）：两台设备把同一张空页各转一次必须得到同一个身份，
  //   否则合并时同一段会变成两段。"空页的 id 要不要由保存路径先铸"是 Slice B 的口径问题，
  //   已记在 `docs/plans/2026-09-23-crdt-stage2-kickoff.md`。
  const emptyRoot = JSON.parse(normalized) as { root?: { children?: unknown[] } };
  if (!Array.isArray(emptyRoot.root?.children) || emptyRoot.root.children.length === 0) {
    return EMPTY_PAGE_MODEL_JSON;
  }
  // ★ **这一层不造身份**：`toModelDoc` 会给缺 `blockId` 的顶层块铸一个 id —— 而铸 id 必须**只发生一次**。
  //   若这里随手铸：两台设备把同一页各转一次 ⇒ 同一块拿到两个 id ⇒ 合并后**变成两块**（比丢更新更难查）。
  //   所以缺身份时**当场报错**，由调用方先走应用既有的补种（保存路径那条）再来转换。
  //   与阶段 1 的「没有身份 ⇒ 不猜、不造身份」是同一条纪律（见 `blockRev.ts` 头注）。
  return toModelDoc(normalized, () => {
    throw new Error(
      "contentJsonToYDoc: 有顶层块缺 blockId —— 本层不造身份（两设备各造一套 ⇒ 同一块会被当成两块）。" +
        "先走应用既有的补种（保存路径的 serializeWithBlockIds），再来转换。",
    );
  });
}

/** 落盘形态的 `content_json` → yjs doc（并回一份可传输的 update 字节）。 */
export function contentJsonToYDoc(contentJson: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  doc.get(ROOT_KEY_V2, Y.XmlElement);
  const editor = newEditor();
  const binding = createBindingV2__EXPERIMENTAL(editor, BINDING_KEY, doc, new Map());

  // 真插件的写法：先挂 update 监听，再 `setEditorState`，把这一次变更手动推给 yjs。
  // 类型直接从 `syncLexicalUpdateToYjsV2__EXPERIMENTAL` 的签名派生 —— 不重复声明一遍形状。
  // ⚠️ 用**对象盒**收 payload：`let x = null` ＋ 只在闭包里赋值时，TS 的控制流分析看不见那次赋值，
  //    `if (!x) throw` 之后会把 `x` 收窄成 `never`（`never` 上读任何属性都报错）。属性访问的收窄才准。
  type SyncArgs = Parameters<typeof syncLexicalUpdateToYjsV2__EXPERIMENTAL>;
  const box: {
    payload?: {
      prevEditorState: SyncArgs[2];
      editorState: SyncArgs[3];
      dirtyElements: SyncArgs[4];
      dirtyLeaves: SyncArgs[5];
      normalizedNodes: SyncArgs[6];
      tags: SyncArgs[7];
    };
  } = {};
  const unregister = editor.registerUpdateListener((payload) => {
    box.payload = payload;
  });
  editor.setEditorState(editor.parseEditorState(modelJsonOf(contentJson)));
  unregister();
  const p = box.payload;
  if (!p) {
    throw new Error("contentJsonToYDoc: setEditorState 没触发 update 监听器（@lexical/yjs 的用法变了？）");
  }
  syncLexicalUpdateToYjsV2__EXPERIMENTAL(
    binding,
    providerStub(),
    p.prevEditorState,
    p.editorState,
    p.dirtyElements,
    p.dirtyLeaves,
    p.normalizedNodes,
    p.tags,
  );
  return { doc, update: Y.encodeStateAsUpdate(doc) };
}

/** yjs update 字节 → 落盘形态的 `content_json`（模型形态过了 `toLegacyDoc`）。 */
export function yDocToContentJson(update: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const editor = newEditor();
  const binding = createBindingV2__EXPERIMENTAL(editor, BINDING_KEY, doc, new Map());
  syncYjsStateToLexicalV2__EXPERIMENTAL(binding, providerStub());
  return toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()));
}

/** 一步往返：落盘 JSON →（yjs）→ 落盘 JSON'。判据用；生产路径将来按需分开调。 */
export function roundTripContentJson(contentJson: string): string {
  return yDocToContentJson(contentJsonToYDoc(contentJson).update);
}

// 供判据/调试：`DOC_NAME` 与 `ROOT_KEY_V2` 是这一层的约定常量，别在别处再写字面量。
export const CRDT_DOC_NAME = DOC_NAME;
export const CRDT_ROOT_KEY_V2 = ROOT_KEY_V2;

// =====================================================================================
// S2（冲刺切片 S2，2026-09-23）：**同一血统的活会话**
//
// 为什么非要有它 —— 是 S1 那条例外红线逼出来的：
// `contentJsonToYDoc` **每次新建** doc，若拿它当保存形态，两台设备把同一页各转一次就得到
// **两套 CRDT 身份**，合起来一块变两块、而且两块 `blockId` 相同
// （`mergeability.test.ts` ① 实测：`["paragraph#blk-1","paragraph#blk-1"]`）。
//
// ⇒ 能合的用法只有一种：**载入既有状态、在它上面继续演进**（"血统" = doc 的 clientID ＋ 时钟，
// 它随 update 字节一起走，所以 `Y.applyUpdate` 到新 doc 上**仍然延续**同一条血统）。
// 本会话就是这条用法的**唯一实现**：`openPageSession({ state })` 载入，`edit()` 产增量，
// `exportState()` 存回，`merge()` 收另一端的更新。
//
// **S3 起是活绑定**：把"本地编辑 → yjs"接成**常驻**监听（不再每次编辑手动挂一次），
// 因此也**提供 `dispose()`** 撤掉它（S2a 时没有 dispose，因为那时没有常驻副作用）。
// 回声由库自己挡：`syncYjsStateToLexicalV2` 落进编辑器的变更带 `COLLABORATION_TAG`，而
// `syncLexicalUpdateToYjsV2` 见到它（且没有规范化节点）就**当场返回**
// —— 这是读 `@lexical/yjs` 的 V2 实现（`dist/LexicalYjs.dev.mjs:3725`）得到的行为，不是猜的。
// ⚠️ 仍然**不造身份**：`json` 那条入口沿用 `modelJsonOf` 的口径（缺 `blockId` ⇒ 抛）。
// =====================================================================================

/** 一页的**活会话**：载入既有血统 → 本地编辑 → 存回状态 / 合并另一端。 */
export interface PageSession {
  /** 当前血统的状态字节（可落盘、可传输；合并 = 交换它）。 */
  exportState(): Uint8Array;
  /** 落盘形态投影（还没换形态的下游继续用；与 `yDocToContentJson(exportState())` 同源）。 */
  exportJson(): string;
  /** 本地编辑：在**同一血统**上产生增量（`mutate` 在 Lexical 的更新窗口内执行）。 */
  edit(mutate: () => void): void;
  /**
   * 合并另一份状态（另一端／服务端来的），并把结果落回编辑器。
   */
  merge(remote: Uint8Array): void;
  /**
   * 订阅「**真·本地编辑**」（S3b）。
   *
   * 为什么要有它：真编辑器的保存路径是"每次 update 就 `onSave(json)`"（`editor/Editor.tsx`），
   * 而 CRDT 下**远端合并 / 载入**也会触发 update —— 那些**不该**被当成用户编辑去落盘。
   * 判据口径：**hydration（载入/合并落回编辑器）期间不报**，其余 update 报一次。
   * 返回取消订阅的函数。
   */
  onLocalEdit(cb: () => void): () => void;
  /**
   * 撤掉常驻监听（**S3 起才有意义**：S2a 那次没有常驻副作用）。
   *
   * ⚠️ 只是撤监听：不销毁 editor/doc（本切片不持有它们的生命周期），也不动已落盘的状态。
   */
  dispose(): void;
}

/**
 * 打开一页的会话。
 *
 * - `state`：既有页（**首选**：这是唯一能延续血统的入口）；
 * - `json`：首次落盘（此刻还没有任何 CRDT 状态，由这份 JSON 建血统）。
 * - `editor`：**要绑定的既有编辑器**（真编辑器接线用，S3b）。不给就自己造一个 headless 的。
 * - 两者都没给 ⇒ **抛**（"你想从哪来"必须明确，别默认空页 —— 那会把一页的真实内容当空页处理）。
 */
export function openPageSession(opts: { json?: string; state?: Uint8Array; editor?: LexicalEditor }): PageSession {
  if (!opts.state && opts.json === undefined) {
    throw new Error("openPageSession: 必须给 state（既有页）或 json（首次落盘），不许两者都空");
  }
  const doc = new Y.Doc();
  doc.get(ROOT_KEY_V2, Y.XmlElement);
  const editor = opts.editor ?? newEditor();
  const binding = createBindingV2__EXPERIMENTAL(editor, BINDING_KEY, doc, new Map());
  const provider = providerStub();

  // ★ **hydration 窗口**（S3b）：载入/合并会把状态落回编辑器，那也算一次 update，
  // 但它**不是**用户编辑 ⇒ 这个窗口内不报 `onLocalEdit`（否则真编辑器会在"打开页面"时
  // 立刻把同一份内容再存一遍，还会把它当成一笔本地改动推上去）。
  // ⚠️ `syncYjsStateToLexicalV2` 用的是 `discrete: true` ⇒ **同步**执行，窗口能精确盖住它。
  let hydrating = false;
  const localEditListeners = new Set<() => void>();

  // ★ **活绑定（S3）**：把"本地编辑 → yjs"接成**常驻**监听 —— 不再每次编辑手动挂一次。
  // 回声由库自己挡：`syncYjsStateToLexicalV2` 落进编辑器的变更带 `COLLABORATION_TAG`，
  // 而 `syncLexicalUpdateToYjsV2` 见到这个 tag（且没有规范化节点）就**当场返回**。
  const unregister = editor.registerUpdateListener((p) => {
    syncLexicalUpdateToYjsV2__EXPERIMENTAL(
      binding,
      provider,
      p.prevEditorState,
      p.editorState,
      p.dirtyElements,
      p.dirtyLeaves,
      p.normalizedNodes,
      p.tags,
    );
    if (!hydrating) {
      for (const cb of [...localEditListeners]) cb();
    }
  });

  if (opts.state) {
    // 载入既有血统：先灌 doc，再从 doc 落到编辑器（那一次更新带 `COLLABORATION_TAG` ⇒ 不会回声）。
    hydrating = true;
    try {
      Y.applyUpdate(doc, opts.state);
      syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider);
    } finally {
      hydrating = false;
    }
  } else {
    // 首次落盘：由这份 JSON **建血统**。这一次 `setEditorState` **不带** collab tag ⇒ 常驻监听会
    // 把它推给 yjs —— 这正是"建血统"那一步（与 `contentJsonToYDoc` 里手动推的那一次等价）。
    // ⚠️ 它也不算"用户编辑" ⇒ 同样在 hydration 窗口里。
    hydrating = true;
    try {
      editor.setEditorState(editor.parseEditorState(modelJsonOf(opts.json!)));
    } finally {
      hydrating = false;
    }
  }

  return {
    exportState: () => Y.encodeStateAsUpdate(doc),
    exportJson: () => toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON())),
    edit(mutate) {
      editor.update(mutate, { discrete: true });
    },
    merge(remote) {
      hydrating = true;
      try {
        Y.applyUpdate(doc, remote);
        // 把合并结果落回编辑器（那一次更新带 collab tag ⇒ 不会回声）。
        syncYjsStateToLexicalV2__EXPERIMENTAL(binding, provider);
      } finally {
        hydrating = false;
      }
    },
    onLocalEdit(cb) {
      localEditListeners.add(cb);
      return () => {
        localEditListeners.delete(cb);
      };
    },
    dispose() {
      localEditListeners.clear();
      unregister();
    },
  };
}
