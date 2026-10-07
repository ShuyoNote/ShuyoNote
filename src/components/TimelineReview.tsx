// KB-S3-TIMELINE —— S3「时间复盘页」的**视图层**（只读 ✓）。
//
// 两块数据，职责分清：
//   · **页面级时间轴**来自 `useNotes().pages`（**已有的**只读出口 ✓）—— 分天、空态、汇总都在 `kbTimeline.ts` ✓；
//   · **块级明细**来自只读命令 `activity_feed`（S3 第三片 ✓；桌面与 Web 同口径 ✓）——
//     按「页 ＋ 天」挂到上面那条上 ✓，键里的 `day` 仍走**唯一**那处口径 `TIMELINE_DAY_BUCKET` ✓。
// ⚠️ 明细读不到时**照实说**（页面上留一行提示 ✓），不许假装"这段时间没有改动" ✗。
//
// 两种空态**必须长得不一样**（这是 S3 第②条的全部意义 ✓）：
//   · `tl-empty-nopages`      —— 这个空间还没有页面 ⇒ 该引导去建第一篇 ✓
//   · `tl-empty-noactivity`   —— 有页面，但窗口内没有活动 ⇒ 该引导去翻旧账/放宽窗口 ✓
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import {
  TIMELINE_DAY_BUCKET,
  blocksByPageDay,
  buildTimeline,
  dayLabelOf,
  timelineStateOf,
  type TimelineDay,
} from "../lib/kbTimeline";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import type { ActivityBlockChange, ActivityEvent } from "../types";

/** 一行里最多摆几个块标签 ✓（再多就折成一句「另有 N 段」✓）。 */
const BLOCK_CHIPS = 3;
/** 三种变化各自的**词**与**记号** ✓（记号只做视觉提示，词走 i18n ✓）。 */
const KIND_KEY = {
  added: "timeline.blockKindAdded",
  edited: "timeline.blockKindEdited",
  removed: "timeline.blockKindRemoved",
} as const satisfies Record<ActivityBlockChange["kind"], string>;
const KIND_MARK: Record<ActivityBlockChange["kind"], string> = { added: "+", edited: "~", removed: "−" };

function DayHeading({ day, now }: { day: string; now: number }) {
  const { t } = useTranslation();
  const label = dayLabelOf(day, now);
  if (label.kind === "today") return <span>{t("timeline.today")}</span>;
  if (label.kind === "yesterday") return <span>{t("timeline.yesterday")}</span>;
  return <span>{t("timeline.date", { month: label.month, day: label.day })}</span>;
}

export function TimelineReview() {
  const { t } = useTranslation();
  const pages = useNotes((s) => s.pages);
  const openPage = useNotes((s) => s.openPage);
  /** ⭐ 2026-10-07：打开一篇 —— **失败必须说出来** ✓（原来 `openPage` 把错误吞进 store ✗，
   *  点了没反应，用户只能看到"打不开" ✓；实测那种情况下 store 里就是「该节点不是页面」✓）。 */
  const openEntry = async (id: string) => {
    await openPage(id);
    const err = useNotes.getState().error;
    if (err) toast(`打不开这一条：${err}`, "error");
  };
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [feedErr, setFeedErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .activityFeed()
      .then((rows) => {
        if (!alive) return;
        setFeed(rows);
        setFeedErr(null);
      })
      .catch((e: unknown) => {
        // 照实：明细读不到就说读不到 ✓（页面级时间轴照常显示 ✓）
        if (alive) setFeedErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 「现在」在**这次渲染**里只取一次 ✓（别在 map 里反复 new Date() ⇒ 同一条活动可能跨日界 ✓）
  const now = useMemo(() => Date.now(), [pages]);
  const state = useMemo(() => timelineStateOf(pages, now), [pages, now]);
  const days: TimelineDay[] = useMemo(() => buildTimeline(pages, now), [pages, now]);
  const byPageDay = useMemo(() => blocksByPageDay(feed, TIMELINE_DAY_BUCKET), [feed]);

  if (state === "no_pages") {
    return (
      <div className="timeline-review tl-empty tl-empty-nopages" role="status">
        <h2 className="tl-title">{t("timeline.title")}</h2>
        <p className="tl-empty-main">{t("timeline.emptyNoPages")}</p>
        <p className="tl-empty-hint">{t("timeline.emptyNoPagesHint")}</p>
      </div>
    );
  }
  if (state === "no_recent_activity") {
    return (
      <div className="timeline-review tl-empty tl-empty-noactivity" role="status">
        <h2 className="tl-title">{t("timeline.title")}</h2>
        <p className="tl-empty-main">{t("timeline.emptyNoActivity")}</p>
        <p className="tl-empty-hint">{t("timeline.emptyNoActivityHint")}</p>
      </div>
    );
  }

  return (
    <div className="timeline-review">
      <h2 className="tl-title">{t("timeline.title")}</h2>
      <p className="tl-window-note">
        {t("timeline.windowNote", { days: days.length })}
        {feedErr ? " · " + t("timeline.detailUnavailable", { why: feedErr }) : ""}
      </p>
      <ol className="tl-days">
        {days.map((d) => (
          <li key={d.day} className="tl-day">
            <div className="tl-day-head">
              <DayHeading day={d.day} now={now} />
              <span className="tl-day-summary">{t("timeline.summary", { created: d.created, edited: d.edited })}</span>
              <span className="tl-day-key">{d.day}</span>
            </div>
            <ul className="tl-entries">
              {d.entries.map((e) => {
                const chs = byPageDay.get(e.id + "@" + d.day) ?? [];
                return (
                  <li key={e.id} className="tl-entry">
                    <button type="button" className="tl-entry-btn" onClick={() => void openEntry(e.id)}>
                      <span className={"tl-kind tl-kind-" + e.kind}>
                        {e.kind === "created" ? t("timeline.kindCreated") : t("timeline.kindEdited")}
                      </span>
                      <span className="tl-entry-title">{e.title}</span>
                      {chs.length > 0 && (
                        <span className="tl-blocks">
                          {chs.slice(0, BLOCK_CHIPS).map((c, i) => (
                            // 给人看的是**这一段的首行** ✓；块 id 退到 tooltip（id 对用户没意义 ✓）
                            <span
                              key={c.blockId + "#" + i}
                              className={"tl-block tl-block-" + c.kind}
                              title={t(KIND_KEY[c.kind]) + " · " + c.blockId}
                            >
                              <span className="tl-block-mark" aria-hidden="true">
                                {KIND_MARK[c.kind]}
                              </span>
                              {c.label || t("timeline.blockUntitled")}
                            </span>
                          ))}
                          {chs.length > BLOCK_CHIPS && (
                            <span className="tl-block-more">{t("timeline.blockMore", { count: chs.length - BLOCK_CHIPS })}</span>
                          )}
                        </span>
                      )}
                    </button>
                    <span className="tl-entry-time">
                      {new Date(e.atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
