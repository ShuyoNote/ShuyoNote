import { useEffect, useRef, useState } from "react";
import { markdownToPageContent } from "../lib/mdPreview";
import { pushOverlay } from "../lib/overlayStack";
import { useNotes } from "../store/notes";
import { useMobileNav } from "../store/mobileNav";
import { BookmarkIcon } from "./icons";

/**
 * **听书打点**（最小打点模式，2026-10-20）—— 手机档底栏第 4 项「听」的整屏。
 *
 * owner 的原话是「打点时可顺手打一句话」⇒ 本屏只做**打点**这一件事 ✓：
 * 计时 ＋ 按一下记一个时刻（可选一句话）＋ 结束把它们落成**一条普通笔记** ✓。
 *
 * ⛔ **刻意不做的**（⛔ 别在下一刀里"顺手"加进来 ✗）：
 * - 不录音、不碰麦克风、不转写、不调 AI、不上传、不发任何网络请求 ✓ ——
 *   本屏唯一的写入就是 `createPage`（本机笔记库）✓。
 * - 不新写"追加内容块"的第二套管线 ✓：落库走仓库现成的
 *   `markdownToPageContent()` ＋ `createPage()`（与 `MobileCapture` 同一条路 ✓）。
 * - ⛔ 不用系统弹窗（`confirm()` / `alert()`）✗：打点那句话是**内联**的一小块输入 ✓，
 *   「清空重来」的二次确认也是**按钮自己变成确认态** ✓。
 *
 * 照任务逐条 ✓：
 * - 标题「听书打点」＋ 一句「不录音、不上传 —— 只记你按下的那一刻」✓
 * - 大号 `HH:MM:SS`（未开始 `00:00:00`）＋「开始听」/「暂停」/「继续」✓
 * - 大「打点」按钮（主色实心，触区 68px ≥56）⇒ 内联「一句话」输入 ＋「记下」/「只记时间」✓
 * - 打点清单：空态一句话 / 「已打 N 个点」；每条 `[HH:MM:SS] 文字`，可删除 ✓
 * - 「结束」⇒ 生成一条笔记（标题 `听书笔记 · MM-DD HH:mm`，正文逐行时间戳）⇒ 跳到那条笔记 ＋ 清本屏 ✓
 * - 「清空重来」⇒ 二次确认后只清本屏状态（⛔ 不删任何笔记 ✗）✓
 *
 * ⚠️ 状态**是本屏的**（`useState` ✓）：切到别的 tab 再回来 ⇒ 计时与打点会重来 ✓。
 *    这是"最小打点模式"的如实边界（⛔ 没做跨 tab 保活 ✗）；`App.tsx` 里本屏与阅读屏的
 *    优先级见那一支的注释 ✓。
 */

/** 本屏的一条打点：`time` 是**相对开始听**的时刻（不是墙上时间 ✓）。 */
interface ListenMark {
  id: number;
  time: string;
  text: string;
}

/** 毫秒 ⇒ `HH:MM:SS`（小时不封顶；未开始/归零时就是 `00:00:00` ✓）。 */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function MobileListen() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）
  const createPage = useNotes((s) => s.createPage);
  const setScreen = useMobileNav((s) => s.setScreen);

  const [elapsedMs, setElapsedMs] = useState(0);
  const [running, setRunning] = useState(false);
  const [marks, setMarks] = useState<ListenMark[]>([]);
  /** 打开中的内联输入：`time` 是**按下「打点」那一刻**的时刻 ✓（不是点「记下」时 ✓）。 */
  const [drafting, setDrafting] = useState<{ time: string } | null>(null);
  const [text, setText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** 计时基准：每 250ms 用"墙上时间差"重算 ⇒ 不会因 setInterval 漂移越走越慢 ✓。 */
  const elapsedRef = useRef(0);
  const nextId = useRef(1);

  // ⭐ 安卓返回键：和「快速记录」同一个坑 ✗（不接就是**直接退出应用** ✗）⇒ 接仓库既有的返回栈 ✓。
  //   ⚠️ 不用 `useOverlayLayer`：它要求把 id 登记进 `verify-mobile-overlays.mjs` 的浮层清单 ✓，
  //   而那份清单会在**每个视口**打开它 ⇒ 只在手机档渲染的本屏会造假红 ✗（`MobileCapture` 同款处置 ✓）。
  useEffect(() => pushOverlay("mobile-listen", () => setScreen("home")), [setScreen]);

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now() - elapsedRef.current;
    const timer = window.setInterval(() => {
      elapsedRef.current = Date.now() - startedAt;
      setElapsedMs(elapsedRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [running]);

  const clock = formatClock(elapsedMs);

  /** 清本屏状态（⛔ 不碰任何笔记 ✗）。结束时与「清空重来」的第二次点击共用 ✓。 */
  function resetScreen() {
    setRunning(false);
    elapsedRef.current = 0;
    setElapsedMs(0);
    setMarks([]);
    setDrafting(null);
    setText("");
    setConfirmClear(false);
    setErr(null);
  }

  function toggleTimer() {
    setConfirmClear(false);
    setErr(null);
    if (running) {
      // 暂停 ⇒ interval 停掉；读数停在最后一次 tick（≤250ms 的滞后，下一轮"继续"从它接着走 ✓）。
      setRunning(false);
      return;
    }
    setRunning(true);
  }

  /** 大「打点」：再按一次＝收起（不改任何已有打点 ✓）。 */
  function toggleDraft() {
    setConfirmClear(false);
    setErr(null);
    if (drafting) {
      setDrafting(null);
      setText("");
      return;
    }
    // ⭐ 时刻在**按下的这一刻**定格（"只记你按下的那一刻" ✓）。
    setDrafting({ time: formatClock(elapsedRef.current) });
    setText("");
  }

  function addMark(withText: boolean) {
    if (!drafting) return;
    const body = withText ? text.trim() : "";
    setMarks((list) => [...list, { id: nextId.current++, time: drafting.time, text: body }]);
    setDrafting(null);
    setText("");
    setErr(null);
  }

  /** 「结束」：打点清单 ⇒ 一条普通笔记（逐行 `[HH:MM:SS] 文字` ✓）。 */
  async function finish() {
    if (busy || marks.length === 0) return;
    setBusy(true);
    setErr(null);
    const lines = marks.map((m) => (m.text ? `[${m.time}] ${m.text}` : `[${m.time}]`));
    // ⚠️ 用**空行**连接（`\n\n`），不是单换行 ✗ —— 实测（2026-10-20）：单换行在
    //    `markdownToPageContent` 里落成同一段里的软换行 ✓，而 `MobileRead` 的 `.mread-p`
    //    没有 `white-space: pre-wrap` ⇒ 阅读时两条会**并成一行**（`[00:00:01] …[00:00:02]` ✗）。
    //    空行 ⇒ 每条一个段落 ⇒ 笔记里 / 阅读屏上都是**真的逐行** ✓（内容仍是 `[HH:MM:SS] 文字` ✓）。
    const content = markdownToPageContent(lines.join("\n\n"));
    if (!content) {
      setErr("正文没能生成，打点还留着 —— 再试一次");
      setBusy(false);
      return;
    }
    const now = new Date();
    const title = `听书笔记 · ${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    // ⚠️ 顺序要紧：先建页（默认 `select` ⇒ 它会置 `currentId`），**再**离开本屏 ✓。
    //    `App.tsx` 里 `listen` 支排在 `currentId` **之前** ✓ ⇒ 若先离开，建页失败时本屏状态就没了 ✗；
    //    反过来，建页成功后不离开 ⇒ 阅读屏被 listen 支挡住 ⇒ 用户以为"结束没反应" ✗。
    const id = await createPage(null, { ...content, title });
    if (!id) {
      setErr("笔记没存上，打点还留着 —— 再试一次");
      setBusy(false);
      return;
    }
    resetScreen();
    setScreen("home");
  }

  /** 「清空重来」：第一次只把按钮切成确认态，第二次才清 ✓（⛔ 不用系统弹窗 ✗）。 */
  function clearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    resetScreen();
  }

  return (
    <div className="mshell mlisten" data-testid="mobile-listen">
      <header className="mlisten-head">
        <h1 className="mlisten-title">听书打点</h1>
        <p className="mlisten-sub">不录音、不上传 —— 只记你按下的那一刻</p>
      </header>

      {/* ⏱ 计时器：大号 HH:MM:SS ＋ 开始/暂停/继续 */}
      <section className="mlisten-timer" aria-label="计时器">
        <span className="mlisten-clock" data-testid="mobile-listen-clock" aria-live="off">
          {clock}
        </span>
        <button
          type="button"
          className="mlisten-toggle"
          onClick={toggleTimer}
          disabled={busy}
        >
          {running ? "暂停" : elapsedMs > 0 ? "继续" : "开始听"}
        </button>
      </section>

      {/* ⭐ 大「打点」：主色实心、68px 高（≥56×56 ✓）；再按一次收起输入 ✓ */}
      <button
        type="button"
        className="mlisten-mark"
        data-testid="mobile-listen-mark"
        aria-expanded={drafting !== null}
        onClick={toggleDraft}
        disabled={busy}
      >
        <BookmarkIcon width={22} height={22} />
        打点
      </button>

      {/* ⭐ 内联「一句话」输入（⛔ 不用系统弹窗 ✗） */}
      {drafting && (
        <div className="mlisten-editor" data-testid="mobile-listen-editor">
          <div className="mlisten-editor-time">记在 {drafting.time}</div>
          <input
            className="mlisten-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addMark(true);
            }}
            placeholder="顺手记一句（可留空）"
            aria-label="打点的一句话"
            maxLength={200}
          />
          <div className="mlisten-editor-actions">
            <button type="button" className="mlisten-justtime" onClick={() => addMark(false)}>
              只记时间
            </button>
            <button type="button" className="mlisten-save" onClick={() => addMark(true)}>
              记下
            </button>
          </div>
        </div>
      )}

      {err && <div className="mlisten-err">{err}</div>}

      {/* 打点清单 */}
      <div className="mlisten-listwrap">
        {marks.length === 0 ? (
          <p className="mlisten-empty">还没打点 —— 听到关键处就按上面那颗</p>
        ) : (
          <>
            <div className="mlisten-count">已打 {marks.length} 个点</div>
            <ul className="mlisten-list" data-testid="mobile-listen-list">
              {marks.map((m) => (
                <li key={m.id} className="mlisten-item">
                  <span className="mlisten-time">[{m.time}]</span>
                  {m.text && <span className="mlisten-text">{m.text}</span>}
                  <button
                    type="button"
                    className="mlisten-del"
                    aria-label="删除这条打点"
                    onClick={() => setMarks((list) => list.filter((x) => x.id !== m.id))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* 底部：结束（生成笔记）／清空重来（二次确认） */}
      <div className="mlisten-foot">
        <button
          type="button"
          className="mlisten-clear"
          data-confirm={confirmClear ? "true" : "false"}
          onClick={clearAll}
          disabled={busy}
        >
          {confirmClear ? "再点一次，确认清空" : "清空重来"}
        </button>
        <button
          type="button"
          className="mlisten-end"
          onClick={() => void finish()}
          disabled={busy || marks.length === 0 || drafting !== null}
          title={marks.length === 0 ? "先打一个点，才能结束" : undefined}
        >
          {busy ? "生成中…" : "结束"}
        </button>
      </div>
    </div>
  );
}
