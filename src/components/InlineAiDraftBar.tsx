import { useEffect, useRef, useState } from "react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useAiStore } from "../store/ai";
import { useNotes } from "../store/notes";
import { useEditorStore } from "../store/editor";
import { runInlineDraft, INLINE_TEMPLATES, type InlineTemplate } from "../lib/ai/inlineDraft";
import { cleanDraftText } from "../lib/ai/lexical";
import type { ProviderConfig } from "../lib/ai/llm";
import { SparkleIcon, SendIcon } from "./icons";
import { Markdown } from "./Markdown";

// Floating "AI drafting" popover (M18): opens anchored to the caret via the space
// trigger, follows the cursor, and closes on background click. Streams the reply
// into a highlighted pending draft → 完成(insert into doc & auto-save) / 关闭.
export function InlineAiDraftBar() {
  const config = useAiStore((s) => s.config);
  const notes = useNotes();
  const open = useEditorStore((s) => s.aiBarOpen);
  const setOpen = useEditorStore((s) => s.setAiBarOpen);
  const pos = useEditorStore((s) => s.aiBarPos);
  const barRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState("");
  const [error, setError] = useState<string | null>(null);

  const runSeqRef = useRef(0);
  const stoppedRef = useRef(false);
  const draftBuf = useRef("");
  const thinkBuf = useRef("");
  const flushTimer = useRef<number | null>(null);

  const flush = () => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    setDraft(draftBuf.current);
    setThinking(thinkBuf.current);
  };
  const scheduleFlush = () => {
    if (flushTimer.current === null) flushTimer.current = window.setTimeout(flush, 50);
  };

  const wrapError = (e: unknown) => String((e as Error)?.message ?? e);

  const start = async (text: string) => {
    const trimmed = (text ?? "").trim();
    if (!trimmed || running || !config.enabled) return;
    const seq = ++runSeqRef.current;
    stoppedRef.current = false;
    const allPages = notes.pages.map((p) => ({ id: p.id, title: p.title, parent_id: p.parent_id }));
    draftBuf.current = "";
    thinkBuf.current = "";
    setDraft("");
    setThinking("");
    setError(null);
    setRunning(true);
    setPrompt("");
    setTemplatesOpen(false);
    try {
      const res = await runInlineDraft(
        config as ProviderConfig,
        trimmed,
        allPages.map((p) => ({ id: p.id, title: p.title })),
        { currentPageId: notes.currentId, allPages },
        {
          onDelta: (t) => {
            if (stoppedRef.current || seq !== runSeqRef.current) return;
            draftBuf.current += t;
            scheduleFlush();
          },
          onThinking: (t) => {
            if (stoppedRef.current || seq !== runSeqRef.current) return;
            thinkBuf.current += t;
            scheduleFlush();
          },
        },
      );
      if (seq !== runSeqRef.current) return;
      draftBuf.current = res.reply;
      thinkBuf.current = res.thinking ?? thinkBuf.current;
      flush();
      setRunning(false);
      if (res.error) setError(res.error);
    } catch (e) {
      if (seq !== runSeqRef.current) return;
      flush();
      setRunning(false);
      setError(wrapError(e));
    }
  };

  const stop = () => {
    stoppedRef.current = true;
    runSeqRef.current++;
    flush();
    setRunning(false);
  };

  const commit = () => {
    if (!draft.trim()) return;
    // Strip AI narration/markdown residue so only the clean content lands in the page.
    const content = cleanDraftText(draft);
    if (!content.trim()) { reset(); return; }
    const editor = useEditorStore.getState().editor;
    if (editor) {
      // Insert as real content (untagged → Editor.onChange persists it), then close.
      editor.update(() => {
        const root = $getRoot();
        const lines = content.split("\n").map((s) => s.trim()).filter(Boolean);
        for (const line of lines) {
          const p = $createParagraphNode();
          p.append($createTextNode(line));
          root.append(p);
        }
      });
    } else {
      // eslint-disable-next-line no-console
      console.warn("[ShuyoNote] inline commit without a live editor; draft dropped.", content);
    }
    reset();
  };

  const reset = () => {
    setOpen(false);
    setPrompt("");
    setRunning(false);
    setDraft("");
    setThinking("");
    setError(null);
    setTemplatesOpen(false);
  };

  // Template dropdown opens by default whenever the bar appears.
  useEffect(() => {
    if (open) setTemplatesOpen(true);
  }, [open]);

  // ESC to stop/close while running.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Close on background click (anywhere outside the floating bar).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);

  // Clean any pending flush timer on unmount.
  useEffect(() => {
    return () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    };
  }, []);

  const runningDraft = running;
  const pickTemplate = (t: InlineTemplate) => {
    setPrompt(t.promptTemplate);
    setTemplatesOpen(false);
  };

  if (!open) return null;

  return (
    <div
      ref={barRef}
      className="ai-inline-pop"
      style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, zIndex: 80 }}
    >
      <div className="ai-inline-bar">
        <span className="ai-inline-bar-icon"><SparkleIcon width={16} height={16} /></span>
        <input
          className="ai-inline-input"
          placeholder="告诉 AI 你想写什么…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              start(prompt);
            }
          }}
          autoFocus
          disabled={running}
        />
        <button className="ai-inline-model" onClick={() => setTemplatesOpen((v) => !v)} title="选择起草模板">
          {config.model || "模型"} ▾
        </button>
        <button
          className="ai-inline-send"
          onClick={running ? stop : () => start(prompt)}
          title={running ? "停止 (Esc)" : "发送"}
        >
          {running ? <span className="ai-send-stop" /> : <SendIcon width={16} height={16} />}
        </button>
      </div>

      {templatesOpen && (
        <div className="ai-inline-templates">
          <div className="ai-inline-templates-head">用 AI 起草</div>
          {INLINE_TEMPLATES.map((t) => (
            <button key={t.key} className="ai-inline-template" onClick={() => pickTemplate(t)}>
              <span className="ai-inline-template-label">{t.label}</span>
            </button>
          ))}
        </div>
      )}

      {(runningDraft || draft || error) && (
        <div className="ai-inline-draft">
          {thinking && (
            <details className="ai-think">
              <summary className="ai-think-summary">已深度思考</summary>
              <div className="ai-think-body">{thinking}</div>
            </details>
          )}
          <div className="ai-inline-draft-body">
            <Markdown text={draft || (runningDraft ? "正在创作…" : "")} />
          </div>
          <div className="ai-inline-draft-foot">
            <span className="ai-inline-draft-status">
              {runningDraft ? "AI 正在创作···" : "AI 回复的内容可能与实际结果有偏差，仅供参考。"}
            </span>
            <div className="ai-inline-draft-actions">
              <button className="ai-inline-act" onClick={commit} disabled={running || !draft.trim()} title="完成：插入正文并保存">
                完成
              </button>
              <button className="ai-inline-act" onClick={() => !running && start(prompt || draft)} disabled={running}>
                续写
              </button>
              {running ? (
                <button className="ai-inline-act" onClick={stop} title="停止 (Esc)">停止</button>
              ) : (
                <button className="ai-inline-act" onClick={() => start(prompt || draft)}>重新生成</button>
              )}
              <button className="ai-inline-act danger" onClick={reset}>关闭</button>
            </div>
          </div>
          {error && <div className="ai-inline-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
