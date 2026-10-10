// 信任设备面板（图①/②/④/⑥ 的**界面那一半** ✓）—— 一个**自包含**组件 ＋ **可注入的后端读数** props ✓。
//
// 为什么长成"注入读数"这个形状（**本组件的命门** ✓）：
//   owner 的口径是「**数字从后端来**」✓ —— 「已融合 N 条」「未融合 M 条（重合）」这类数字
//   **必须**由调用方（Rust 那半）算好传进来 ✓，⛔ 组件里自己数、自己推、自己编 ✗。
//   ⇒ 所以读数 props 全是 `Reading<T>`：**要么 `ok`（带值）、要么 `unavailable`（带原因）** ✓，
//     而 `unavailable` 在界面上**只许说"读不到"** —— ⛔ **绝不许退化成 0** ✗：
//     「0 条重合」是**一个结论**，「读不到」是**没有结论** ✓，这两件事在界面上**长得必须不一样** ✓。
//
// 另外两条 owner 口径也钉在这里：
//   · 图① **默认一个都不勾** ⇒ 界面明说「**不勾就不会动**」✓（初值恒为 `[]`，⛔ 不"全选" ✗）
//   · 图④ **严格模式默认关** ✓（`initialStrictMode` 缺省 `false` ✓），且开关旁**说清开了会怎样** ✓
//
// ⚠️ 两条约定（都是别处真事故换来的 ✓）：
//   ① **只用 `App.css` 里既有的类** ✗ 一行都不新造 ✓ —— 见 `McpAccessPane` 2026-10-06 那次：
//      自造 `set-row-*` 子类 ⇒ `App.css` 里根本没有那几条规则 ⇒ 面板是"裸"的 ✓。
//      这里只用 `set-section*` / `set-row*` / `set-hint` / `ui-toggle*` ＋ `sync-row*` / `sync-status`
//      / `sync-btn` / `sync-att*` / `sync-hint` ✓（都逐个核过存在 ✓）。
//   ② 界面里要强调的词一律 `<b>` ✓，⛔ 不写 `**…**` ✗ —— 那是 Markdown，在 JSX 里会**原样显示成星号** ✓。
//
// ⛔ 本组件**不**接触任何平台 API、**不**订阅任何 store、**不**发请求 ✓ —— 纯展示 ＋ 回调 ✓
//   （⛔ 也不渲染任何裸设备号/裸 id 进可见槽位：那是 `INV-UI-copy-no-internal-ids` 管的事 ✓）。
//   挂载点由 Lead 统一加 ✓；本文件是 task-17 的写域 ✓。

import { useMemo, useState } from "react";

/** 一处读数：**拿不到就说拿不到** —— ⛔ 不许拿 0 冒充"没有" ✓。 */
export type Reading<T> =
  | { kind: "ok"; value: T }
  | { kind: "unavailable"; reason: string };

/** 图① 里可供勾选的一个空间（`kind` 与库里 `meta.workspaces.kind` 同形 ✓）。 */
export interface AttachableSpace {
  id: string;
  name: string;
  /** `''` ＝ 未分类（库里就是空串 ⇒ 界面**如实说**，⛔ 不替它猜成"个人" ✗）。 */
  kind: "personal" | "team" | "";
}

/** 图⑥ 里**这一台已经有**的空间（融合之后的样子 ✓）。 */
export interface LocalSpace {
  id: string;
  name: string;
}

/** 图② 的重合读数 —— 两个数字都由**后端**给 ✓。 */
export interface MergeOverlapReading {
  /** 已经并进来的条数 ✓ */
  mergedCount: number;
  /** ⚠️ 还没融合、但**两边重合**的条数 ✓（> 0 时界面必须把它说出来 ✓） */
  unmergedOverlapCount: number;
}

/** 图④ 的数字码 —— ⚠️ 它是**标识**、⛔ 不是秘密 ✗（owner 口径：界面**不要求用户输入任何东西** ✓）。 */
export interface VerifiedDeviceCode {
  /** 已验证的数字码（例：`4821 7390 1562 8473 0291`）✓ */
  code: string;
  /** 是不是**验过**的那一串 ✓ —— ⛔ 没验过就别写成"已验证" ✗ */
  verified: boolean;
}

export interface TrustDevicePanelProps {
  /** 图①：这一台**可以接进来**哪些空间 ✓ */
  attachOffer: Reading<AttachableSpace[]>;
  /** 图⑥：这一台**已经有**哪些空间 ✓ */
  localSpaces: Reading<LocalSpace[]>;
  /** 图②：重合读数（两个数字都来自后端 ✓） */
  mergeOverlap: Reading<MergeOverlapReading>;
  /** 图④：已验证的数字码 ✓ */
  deviceCode: Reading<VerifiedDeviceCode>;
  /** 点「接入」时回传**被勾选**的那些 id ✓（一个都没勾时**不会**被调用 ✓）。 */
  onAttach?: (spaceIds: string[]) => void;
  /** 严格模式开关（默认关 ✓） */
  onStrictModeChange?: (on: boolean) => void;
  /** 只给测试/受控场景用 ✓ —— 缺省 **`false` ＝ 关** ✓（owner 口径）。 */
  initialStrictMode?: boolean;
}

/** 稳定空数组 —— ⛔ 别在渲染里现造 `[]`（那会让下面的 `useMemo` 每次都重算 ✓）。 */
const NO_OFFER: AttachableSpace[] = [];
const NO_LOCAL: LocalSpace[] = [];

/** 读不到时界面上**只许**出现这个说法 ✓（⛔ 不许说 0、⛔ 不许说"没有"✗）。 */
const UNAVAILABLE = "读不到";

/**
 * 按**名字**把本地空间归成"一行一个" —— ⚠️ 这是**展示**，⛔ 不是"融合决定" ✗：
 * 融合是后端的活 ✓，这里只回答"读数里有几条叫这个名字" ✓。
 * ⇒ 于是「工作」**永远只出现一行** ✓（图⑥ 要的就是这个）；而读数里真出现重名时，
 *   由下面那条告警**如实说出来** ✓ —— ⛔ 不静默地并掉、⛔ 也不摆成两行让你以为没事 ✗。
 */
function groupByName(spaces: LocalSpace[]): { name: string; count: number }[] {
  const order: string[] = [];
  const seen = new Map<string, number>();
  for (const s of spaces) {
    if (!seen.has(s.name)) order.push(s.name);
    seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, count: seen.get(name) ?? 0 }));
}

/** `kind` 的人话 —— `''`（未分类）如实说 ✓，⛔ 不替它猜 ✗。 */
function kindText(kind: AttachableSpace["kind"]): string {
  if (kind === "team") return "团队空间 —— 跟着组织走，不参与按名称融合";
  if (kind === "personal") return "个人空间";
  return "未分类 —— 还没定它算哪种（⛔ 不替你猜）";
}

export function TrustDevicePanel({
  attachOffer,
  localSpaces,
  mergeOverlap,
  deviceCode,
  onAttach,
  onStrictModeChange,
  initialStrictMode = false,
}: TrustDevicePanelProps) {
  // ⚠️ **默认一个都不勾** ✓（owner 口径）—— 初值恒为 `[]`，⛔ 不来自读数、⛔ 不"全选"✗
  const [picked, setPicked] = useState<string[]>([]);
  // ⚠️ **严格模式默认关** ✓
  const [strict, setStrict] = useState(initialStrictMode);

  // ⚠️ hooks 全部在**任何 return 之前** ✓（`check-hook-order` 守这条：提前 return 越过 hooks
  //    会让界面直接没掉 —— 那两次事故是 Ctrl+K 白屏 与 加密重启抛错 ✓）。
  const offer = attachOffer.kind === "ok" ? attachOffer.value : NO_OFFER;
  const local = localSpaces.kind === "ok" ? localSpaces.value : NO_LOCAL;
  const groups = useMemo(() => groupByName(local), [local]);
  /** ⚠️ 读数里**重名**的那些（> 1 条）—— 真出现就说明"融合没生效"，要**说出来** ✓。 */
  const duplicated = useMemo(() => groups.filter((g) => g.count > 1), [groups]);
  /**
   * 只算**还在读数里**的那些勾选 ✓ —— 读数换了（空间被删/被移出）之后，旧 id 不该继续算进
   * 「这次会动几个」 ✗（否则界面会报一个**它根本动不了**的数 ✓）。
   */
  const effective = useMemo(
    () => picked.filter((id) => offer.some((s) => s.id === id)),
    [picked, offer],
  );
  const pickedCount = effective.length;
  /**
   * 「**由它自己挑选**」那一行里的三个数 —— ⚠️ **数来自注入的读数** ✓（⛔ 不写死 2／1 ✗）。
   * ⚠️ 与「重合数字」的区别，别混：这两个数是**数注入进来那个数组自己的成员** ✓（读数的形状就是这么多条），
   *    ⛔ **不是**在替后端下任何结论 ✗ —— 而「已融合 N 条」那种是**后端算出来的结论**，
   *    所以它只能整块由读数给 ✓（正是本组件的命门 ✓）。
   */
  const offerCounts = useMemo(() => {
    let personal = 0;
    let team = 0;
    let other = 0;
    for (const s of offer) {
      if (s.kind === "personal") personal++;
      else if (s.kind === "team") team++;
      else other++;
    }
    return { personal, team, other };
  }, [offer]);

  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const attach = () => {
    // ⚠️ 兜底：一个都没勾 ⇒ **什么都不做** ✓（按钮同时也 disabled ✓ —— 两层都挡住，
    //    因为"默认不勾"这条口径的**判据**是"不产生任何改动" ✓）。
    if (pickedCount === 0) return;
    onAttach?.(effective);
  };

  return (
    <div className="trust-device-panel">
      {/* ══════ 图① 「我能给你这些空间」 ══════ */}
      <section className="set-section">
        <div className="set-section-title">我能给你这些空间</div>

        {attachOffer.kind === "unavailable" ? (
          <div className="sync-status is-warn" data-testid="offer-unavailable">
            {UNAVAILABLE}这一台上有哪些空间（{attachOffer.reason}）—— 读不到就一个都不会动 ✓
          </div>
        ) : (
          <>
            <div className="set-hint" data-testid="offer-auto-pick">
              由它自己挑选：{offerCounts.personal} 个个人空间 ＋ {offerCounts.team} 个团队空间
              {offerCounts.other > 0 ? ` ＋ ${offerCounts.other} 个未分类` : ""}
            </div>

            <div className="sync-status is-warn" data-testid="attach-note">
              默认<b>一个都不勾</b> —— <b>不勾就不会动</b>：没勾的空间，这一台不看、不改、也不同步 ✓
            </div>

            {offer.map((s) => (
              <label className="sync-att" key={s.id} data-testid={`offer-${s.id}`}>
                <span className="sync-att-text">
                  <span className="sync-att-name">{s.name}</span>
                  <span className="sync-hint">{kindText(s.kind)}</span>
                </span>
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  onChange={() => toggle(s.id)}
                  aria-label={`接入「${s.name}」`}
                />
              </label>
            ))}

            <div className="sync-status" data-testid="would-change">
              这一次会动 <b>{pickedCount}</b> 个空间
              {offer.length > 0 ? `（这一台一共给出 ${offer.length} 个）` : ""}
            </div>

            <button
              className="sync-btn primary block"
              data-testid="attach"
              disabled={pickedCount === 0}
              onClick={attach}
            >
              接入
            </button>
          </>
        )}
      </section>

      {/* ══════ 图② 「两台空间重合结果」 ══════ */}
      <section className="set-section">
        <div className="set-section-title">两台空间重合结果</div>

        {mergeOverlap.kind === "unavailable" ? (
          // ⛔ 这里**绝不能**写"0 条" —— 那会把"没读到"说成"没有重合"，是两件事 ✓
          <div className="sync-status is-warn" data-testid="overlap-unavailable">
            {UNAVAILABLE}重合结果（{mergeOverlap.reason}）—— 所以现在还<b>说不出</b>有没有重合的条目 ✓
          </div>
        ) : (
          <>
            <div className="sync-status is-ok" data-testid="merged-count">
              已融合 <b>{mergeOverlap.value.mergedCount}</b> 条
            </div>
            {mergeOverlap.value.unmergedOverlapCount > 0 ? (
              <div className="sync-status is-warn" data-testid="unmerged-overlap">
                ⚠️ 未融合 <b>{mergeOverlap.value.unmergedOverlapCount}</b> 条（重合）
              </div>
            ) : (
              <div className="sync-hint" data-testid="no-overlap">
                没有重合的条目（这是后端的读数 ✓）
              </div>
            )}
          </>
        )}
      </section>

      {/* ══════ 图④ 「信任设备」＋ 严格模式（默认关） ══════ */}
      <section className="set-section">
        <div className="set-section-title">信任设备</div>
        <div className="set-hint">两台设备之间已重新建立信任</div>
        <div className="set-hint">由你决定，我不再询问</div>

        {deviceCode.kind === "unavailable" ? (
          <div className="sync-status is-warn" data-testid="code-unavailable">
            {UNAVAILABLE}数字码（{deviceCode.reason}）
          </div>
        ) : (
          <div className="sync-status" data-testid="device-code">
            <b data-testid="device-code-value">{deviceCode.value.code}</b>
            <span className="set-hint">
              {deviceCode.value.verified ? "已验证的数字码" : "还没验证过的数字码"} —— 它只是两台设备
              「对一眼」用的<b>标识</b>：不用你输入、也不用你记 ✓
            </span>
          </div>
        )}

        <details className="sync-row" data-testid="strict-mode">
          <summary>
            <span className="sync-row-label">严格模式（高级）</span>
            <span className="sync-row-value" data-testid="strict-value">
              {strict ? "已开" : "关（默认）"}
            </span>
            <span className="sync-row-caret" aria-hidden>
              ›
            </span>
          </summary>
          <div className="sync-row-body">
            <div className="set-row">
              <div className="set-row-text">
                <div className="set-row-name">逐位对一遍</div>
                <div className="set-row-sub">
                  开了之后：两台会各自显示同一串数字，你要<b>逐位对一遍</b>才继续。
                  默认关 —— 平时用不上，只有你不放心「名字会不会被冒充」时才打开 ✓
                </div>
              </div>
              <button
                type="button"
                className={`ui-toggle${strict ? " on" : ""}`}
                role="switch"
                aria-checked={strict}
                aria-label="严格模式"
                data-testid="strict-toggle"
                onClick={() => {
                  const next = !strict;
                  setStrict(next);
                  onStrictModeChange?.(next);
                }}
              >
                <span className="ui-toggle-knob" />
              </button>
            </div>
          </div>
        </details>
      </section>

      {/* ══════ 图⑥ 「笔记本有哪些空间」 ══════ */}
      <section className="set-section">
        <div className="set-section-title">笔记本有哪些空间</div>

        {localSpaces.kind === "unavailable" ? (
          <div className="sync-status is-warn" data-testid="local-unavailable">
            {UNAVAILABLE}这一台有哪些空间（{localSpaces.reason}）
          </div>
        ) : (
          <>
            <div data-testid="space-list">
              {groups.map((g) => (
                <div className="sync-att" key={g.name} data-testid={`local-${g.name}`}>
                  <span className="sync-att-text">
                    <span className="sync-att-name">
                      {g.name} × {g.count}
                    </span>
                    <span className="sync-hint">
                      {g.count === 1 ? "列表里只有这一个" : "⚠️ 读数里有重名"}
                    </span>
                  </span>
                </div>
              ))}
            </div>

            {duplicated.length > 0 && (
              // ⚠️ 这是**如实报**、⛔ 不是"界面自己修好"✗ —— 同名融合是后端的活 ✓；
              //    真出现重名就说明那一步没生效，界面**必须说出来** ✓（上面那几行仍然一行一个名字 ✓）。
              <div className="sync-status is-warn" data-testid="duplicate-name-warning">
                ⚠️ 读数里有 <b>{duplicated.length}</b> 个重名空间（
                {duplicated.map((d) => `「${d.name}」×${d.count}`).join("、")}）—— 融合还没生效 ✓
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
