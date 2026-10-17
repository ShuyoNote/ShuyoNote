// 「库地图」视图（LLM wiki 第二块 ＋ 第三块的**展示**那一半）—— 把 `buildLibraryMap` 的输出画出来，
// 并在**调用方给了回调**时，每个分区多一个「生成这一页」按钮 ✓。
//
// ## 它不做什么（免得后人给它加错东西）
// · **不取材、不扫描**：地图由调用方（面板）算好传进来 —— 面板与"检查索引覆盖"**共用同一次扫描**，
//   不许多扫一遍（成本 O(页面数) 次命令调用）；
// · **不调用模型**：点按钮只是把 `onGenerate(section)` 喊上去；模型调用在面板/store 那一层 ✓
//   （这样这个组件仍然可以被纯渲染判据测，不需要假 LLM ✓）；
// · **不写任何东西**：没有 hooks、没有副作用、没有 store 订阅 ⇒ 它只是个纯展示组件 ✓。
//
// ## ⚠️ 界面这一半最要紧的两条
// ① **未知 ≠ 0**：`count === null` 必须画成「未知」，**绝不许**画成 0（同一条先例在同步面板里）；
//    由渲染级判据钉住：`LibraryMapView.test.tsx` 同时断言"`null` ⇒ 「未知」且不出现 0"与"`0` ⇒ 0 且不出现「未知」"。
// ② **草稿必须自证"未落库"**：第三块的产物是草稿，界面上必须写着「**草稿，未落库**」＋ 页脚
//    「派生，非出处 ｜ 模型 ｜ 时间」＋ 覆盖度 ⇒ 别让读者以为库已经被改了 ✓

import type { ReactNode } from "react";
import type { LibraryMap, MapSection } from "../lib/ai/libraryMap";
import type { TopicDraft } from "../lib/ai/topicDraft";

/**
 * 把文案里的 `**重点**` 渲染成 `<strong>`。
 * ⚠️ 这是**渲染**层的活儿：地图的 summary/note 是纯字符串，`**` 是写给人看的重点标记；
 *    不处理就会把星号原样画出来（2026-10-18 实测：界面上真是 `**能搜到不等于抽全了**` ✗）。
 */
function withEmphasis(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((p, i) => (p.length > 4 && p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/** 来源最多列 3 个：原始 id 很长，全列会把一行撑成三行（实测 8 个 id = 3 行 ✗） */
const SOURCES_SHOWN = 3;
function sourcesText(sources: string[]): string {
  if (sources.length <= SOURCES_SHOWN) return `来源：${sources.join("、")}`;
  return `来源：${sources.slice(0, SOURCES_SHOWN).join("、")} … 共 ${sources.length} 个`;
}

export interface LibraryMapViewProps {
  map: LibraryMap;
  title?: string;
  /** 给了它 ⇒ 每个分区多一个「生成这一页」按钮（面板接线用）✓ */
  onGenerate?: (section: MapSection) => void;
  /** 正在生成的分区 key（按钮变「生成中…」并禁用 ✓） */
  generatingSection?: string | null;
  /** 第三块的草稿（只在**用户点过**之后才有 ✓；`null` ⇒ 不显示草稿区 ✓） */
  draft?: TopicDraft | null;
  /** 「不采用」：**什么都不写**，只是把草稿清掉 ✓ */
  onDismissDraft?: () => void;
  /**
   * 「采用为页面」（第四块）：**唯一**会把草稿写成真页面的一次点击 ✓
   * ⚠️ 组件自己**仍然不写库**（照第 9 行那条），它只把草稿喊上去；写库在面板那一层
   *   —— 一次 `createPage`、新页、不覆盖任何已有页 ✓。
   */
  onAdoptDraft?: (draft: TopicDraft) => void;
  /** 正在落库（按钮变「保存中…」并禁用，防止连点两次建出两页 ✓） */
  adopting?: boolean;
}

export function LibraryMapView({
  map,
  title = "库地图（只读派生视图）",
  onGenerate,
  generatingSection = null,
  draft = null,
  onDismissDraft,
  onAdoptDraft,
  adopting = false,
}: LibraryMapViewProps) {
  return (
    <div className="ai-libmap" data-testid="library-map">
      <div className="ai-libmap-head">
        <span className="ai-libmap-title">{title}</span>
        <span className="ai-libmap-sub">由覆盖度报告重排：不生成正文、不写库；有格子没读数时显示为「未知」。</span>
      </div>
      {map.sections.map((s) => (
        <section key={s.key} className="ai-libmap-sec" data-section={s.key}>
          <div className="ai-libmap-sec-label">
            {s.label}
            {onGenerate ? (
              <button
                type="button"
                className="ai-libmap-gen"
                data-gen={s.key}
                disabled={generatingSection === s.key}
                onClick={() => onGenerate(s)}
                title="只生成本页草稿，不写库"
              >
                {generatingSection === s.key ? "生成中…" : "生成这一页"}
              </button>
            ) : null}
          </div>
          <div className="ai-libmap-sec-summary">{withEmphasis(s.summary)}</div>
          <ul className="ai-libmap-items">
            {s.items.map((it) => (
              <li key={it.key} className={`ai-libmap-item is-${it.tone}`} data-tone={it.tone} data-item={it.key}>
                <span className="ai-libmap-item-label">{it.label}</span>
                <span className="ai-libmap-item-count" data-count={it.count === null ? "unknown" : String(it.count)}>
                  {it.count === null ? "未知" : it.count}
                </span>
                {it.note ? <span className="ai-libmap-item-note">{withEmphasis(it.note)}</span> : null}
                {it.sources.length > 0 ? <span className="ai-libmap-item-src">{sourcesText(it.sources)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!map.coverageComplete ? (
        <div className="ai-libmap-warn">有格子这次没查（显示为「未知」）—— 未知不等于没有，别把它读成 0。</div>
      ) : null}

      {draft ? (
        <div className="ai-libmap-draft" data-testid="topic-draft" data-topic={draft.title}>
          <div className="ai-libmap-draft-head">
            <span className="ai-libmap-draft-title">草稿：{draft.title}</span>
            {/* 这两行是给读者看的"边界"，判据也断言它们在场 ✓ */}
            <span className="ai-libmap-draft-badge" data-testid="draft-badge">
              草稿，未落库
            </span>
            {onAdoptDraft ? (
              <button
                type="button"
                className="ai-libmap-draft-keep"
                data-testid="draft-adopt"
                disabled={adopting}
                onClick={() => onAdoptDraft(draft)}
                title="新建一页存下这份草稿：只新增，不覆盖任何已有页"
              >
                {adopting ? "保存中…" : "采用为页面"}
              </button>
            ) : null}
            {onDismissDraft ? (
              <button type="button" className="ai-libmap-draft-drop" data-testid="draft-dismiss" onClick={onDismissDraft}>
                不采用
              </button>
            ) : null}
          </div>
          <pre className="ai-libmap-draft-body">{draft.body}</pre>
          <div className="ai-libmap-draft-meta">
            <span data-testid="draft-coverage">{draft.coverage}</span>
            <span data-testid="draft-refs">{draft.refs.length > 0 ? `回链：${draft.refs.join("、")}` : "回链：（无）"}</span>
            {draft.droppedInventedRefs > 0 ? (
              <span className="ai-libmap-draft-warn" data-testid="draft-dropped">
                {`已丢掉模型编造的回链 ${draft.droppedInventedRefs} 条`}
              </span>
            ) : null}
          </div>
          <div className="ai-libmap-draft-footer" data-testid="draft-footer">
            {draft.footer}
          </div>
        </div>
      ) : null}
    </div>
  );
}
