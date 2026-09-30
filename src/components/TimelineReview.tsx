// KB-S3-TIMELINE —— S3「时间复盘页」的**视图层**（只读 ✓）。
//
// 数据来自 `useNotes().pages`（**已有的**只读出口 ✓）⇒ 本组件既不落库、也不碰内容列 ✓；
// 分组、空态、日界全部走 `src/lib/kbTimeline.ts` 那一处口径 ✓
// （判据 `scripts/check-kb-s3-timeline.mjs` 的三条：只读派生／两种空态分得开／时间口径只有一处 ✓）。
//
// 两种空态**必须长得不一样**（这是 S3 第②条的全部意义 ✓）：
//   · `tl-empty-nopages`      —— 这个空间还没有页面 ⇒ 该引导去建第一篇 ✓
//   · `tl-empty-noactivity`   —— 有页面，但窗口内没有活动 ⇒ 该引导去翻旧账/放宽窗口 ✓
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildTimeline, dayLabelOf, timelineStateOf, type TimelineDay } from "../lib/kbTimeline";
import { useNotes } from "../store/notes";

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
  // 「现在」在**这次渲染**里只取一次 ✓ —— 别在 map 里反复 new Date()（同一条活动可能跨过日界）
  const now = useMemo(() => Date.now(), [pages]);
  const state = useMemo(() => timelineStateOf(pages, now), [pages, now]);
  const days: TimelineDay[] = useMemo(() => buildTimeline(pages, now), [pages, now]);

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
      <p className="tl-window-note">{t("timeline.windowNote", { days: days.length })}</p>
      <ol className="tl-days">
        {days.map((d) => (
          <li key={d.day} className="tl-day">
            <div className="tl-day-head">
              <DayHeading day={d.day} now={now} />
              <span className="tl-day-key">{d.day}</span>
            </div>
            <ul className="tl-entries">
              {d.entries.map((e) => (
                <li key={e.id} className="tl-entry">
                  <button type="button" className="tl-entry-btn" onClick={() => void openPage(e.id)}>
                    {e.title}
                  </button>
                  <span className="tl-entry-time">
                    {new Date(e.atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
