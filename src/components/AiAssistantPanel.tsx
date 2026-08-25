import { useEffect, useMemo, useRef, useState } from "react";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { useNotes } from "../store/notes";
import { SparkleIcon, SettingsIcon, SendIcon } from "./icons";
import { Markdown } from "./Markdown";
import { draftPreview } from "../lib/ai/preview";
import { AiSettingsDialog } from "./AiSettingsDialog";

// Context-aware one-click suggestions (Adapted to the current page), with 换一批.
const PAGE_POOL = [
  "总结当前页",
  "为当前页列提纲",
  "列出今日待办",
  "校对当前页的错别字",
  "用一句话概括当前页",
  "把当前页改写得更简明",
];
const EMPTY_POOL = [
  "新建一篇周计划",
  "新建一篇会议纪要",
  "总结这个工作区",
  "列出最近更新的页面",
  "整理重复的笔记",
];

export function AiAssistantPanel() {
  const {
    config,
    running,
    reply,
    drafts,
    error,
    activity,
    history,
    currentPrompt,
    thinking,
    run,
    stop,
    confirm,
    dismiss,
    clearResult,
    resetError,
  } = useAiStore();
  const open = useRightPanel((s) => s.ai);
  const setOpen = useRightPanel((s) => s.openAi);
  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const currentId = useNotes((s) => s.currentId);
  const pageOpen = Boolean(currentId);

  // Resizable panel width (persisted), applied as a CSS var so .main lets space follow.
  const PANEL_W_KEY = "shuyonote.ai.panelWidth";
  const loadWidth = () => {
    try {
      const n = Number(localStorage.getItem(PANEL_W_KEY));
      return Number.isFinite(n) && n >= 300 ? n : 380;
    } catch {
      return 380;
    }
  };
  const [width, setWidth] = useState(loadWidth);
  const widthRef = useRef(width);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    widthRef.current = width;
    document.body.style.setProperty("--ai-w", `${width}px`);
  }, [width]);
  // Keep the live transcript pinned to the bottom as tokens/thinking stream in.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [running, reply, thinking, currentPrompt, history.length]);
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const clamp = (w: number) => Math.min(640, Math.max(300, w));
    const onMove = (ev: PointerEvent) => setWidth(clamp(startW + (startX - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-ai-resizing");
      try {
        localStorage.setItem(PANEL_W_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.classList.add("is-ai-resizing");
  };

  // Reserve right rail space while the panel is open (content shifts, Wolai-style).
  useEffect(() => {
    document.body.classList.toggle("is-ai-open", open);
    return () => document.body.classList.remove("is-ai-open");
  }, [open]);

  // Contextual suggestions (page open ⇒ page-specific prompts), "换一批" rotates.
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const pool = useMemo(() => (pageOpen ? PAGE_POOL : EMPTY_POOL), [pageOpen]);
  const SUGGESTION_COUNT = 3;
  const suggestions = useMemo(() => {
    const start = (suggestionOffset % pool.length + pool.length) % pool.length;
    return Array.from({ length: Math.min(SUGGESTION_COUNT, pool.length) }, (_, i) => pool[(start + i) % pool.length]);
  }, [pool, suggestionOffset]);

  const newConversation = () => {
    clearResult();
    setPrompt("");
  };

  const send = async () => {
    const p = prompt.trim();
    if (!p || running || !config.enabled) return;
    setPrompt("");
    await run(p);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Run a quick prompt directly (skips the textarea state machine).
  const runText = (t: string) => {
    if (running || !config.enabled) return;
    useAiStore.getState().run(t);
  };

  if (!open) return null;

  return (
    <>
      <div className="ai-panel">
        <div className="ai-resizer" onPointerDown={onResizeStart} title="拖动调整宽度" />
        <div className="ai-header">
          <div className="ai-header-main">
            <div className="ai-title-row">
              <SparkleIcon className="ai-header-icon" />
              <span className="ai-title">AI 助手</span>
            </div>
            <div className="ai-header-sub">基于当前空间你所有有权限的页面进行回答</div>
          </div>
          <button className="ai-header-btn ai-settings" title="AI 设置" onClick={() => setSettingsOpen(true)} aria-label="AI 设置">
            <SettingsIcon width={16} height={16} />
          </button>
          <button className="ai-header-btn ai-close" title="关闭" onClick={() => setOpen(false)} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="ai-body">
          {!config.enabled && (
            <div className="ai-disabled">
              <div className="ai-disabled-title">AI 助手尚未启用</div>
              <div className="ai-disabled-desc">
                默认关闭以保护隐私。启用后只调用你配置的本地模型端点，写操作需你确认。
              </div>
              <button className="ai-disabled-cta" onClick={() => setSettingsOpen(true)}>
                打开设置并启用
              </button>
            </div>
          )}

          {config.enabled && (
            <>
              {history.length === 0 && !running && !currentPrompt && !reply ? (
                <>
                  <div className="ai-welcome">
                    <span className="ai-welcome-text">Hi，我是 ShuyoNote 的 AI 助手，可以针对当前笔记或整个空间进行提问，写操作需你确认。</span>
                  </div>
                  <div className="ai-suggestions">
                    <div className="ai-suggestions-head">
                      <span className="ai-suggestions-label">你可以尝试以下问题</span>
                      <button className="ai-suggestions-shuffle" onClick={() => setSuggestionOffset((o) => o + SUGGESTION_COUNT)} title="换一批">
                        换一批
                      </button>
                    </div>
                    <div className="ai-suggestions-list">
                      {suggestions.map((s, i) => (
                        <button key={s} className="ai-suggestion-card" onClick={() => runText(s)}>
                          <span className="ai-suggestion-num">{i + 1}.</span>
                          <span className="ai-suggestion-text">{s}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="ai-transcript" ref={transcriptRef}>
                  {history.map((m, i) => (
                    <div key={i} className={`ai-bubble ai-bubble-${m.role}`}>
                      {m.role === "assistant" ? (
                        <>
                          <div className="ai-bubble-text"><Markdown text={m.content} /></div>
                          {i === history.length - 1 && thinking && <ThinkingBlock text={thinking} />}
                          {i === history.length - 1 && activity.length > 0 && (
                            <div className="ai-activity">
                              <span className="ai-activity-label">工具</span>
                              {activity.map((a, j) => (
                                <span key={`${a.tool}-${j}`} className="ai-activity-item">{a.note}</span>
                              ))}
                            </div>
                          )}
                          <div className="ai-disclaimer">由 AI 生成，仅供参考</div>
                        </>
                      ) : (
                        <div className="ai-bubble-text">{m.content}</div>
                      )}
                    </div>
                  ))}
                  {running && currentPrompt && (
                    <div className="ai-bubble ai-bubble-user">
                      <div className="ai-bubble-text">{currentPrompt}</div>
                    </div>
                  )}
                  {running && (thinking || reply) && (
                    <div className="ai-bubble ai-bubble-assistant">
                      {reply && <div className="ai-bubble-text"><Markdown text={reply} /></div>}
                      {thinking && <ThinkingBlock text={thinking} />}
                      {reply && activity.length > 0 && (
                        <div className="ai-activity">
                          <span className="ai-activity-label">工具</span>
                          {activity.map((a, j) => (
                            <span key={`${a.tool}-${j}`} className="ai-activity-item">{a.note}</span>
                          ))}
                        </div>
                      )}
                      {reply && <div className="ai-disclaimer">由 AI 生成，仅供参考</div>}
                    </div>
                  )}
                </div>
              )}

              {drafts.length > 0 && (
                <div className="ai-drafts">
                  <div className="ai-drafts-title">待确认操作（{drafts.length}）</div>
                  {drafts.map((d) => {
                    const preview = draftPreview(d.payload);
                    return (
                      <div key={d.key} className="ai-draft-item">
                        <div className="ai-draft-main">
                          <span className="ai-draft-summary">{d.summary}</span>
                          {preview && <pre className="ai-draft-preview">{preview}</pre>}
                        </div>
                        <div className="ai-draft-actions">
                          <button className="ai-draft-apply" onClick={() => confirm(d.key)}>应用</button>
                          <button className="ai-draft-discard" onClick={() => dismiss(d.key)}>弃用</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {error && (
                <div className="ai-error" onClick={resetError}>
                  <span>{error}</span>
                  <button className="ai-error-close" title="关闭">×</button>
                </div>
              )}
            </>
          )}
        </div>

        {config.enabled && (
          <div className="ai-footer">
            <button className="ai-footer-btn" onClick={newConversation} title="开始一段新对话">＋ 新会话</button>
            <span className="ai-footer-model" title="当前模型">{config.model}</span>
          </div>
        )}

        <div className="ai-input-row">
          <textarea
            className="ai-textarea"
            placeholder={config.enabled ? "问我你的问题…" : "启用 AI 后可开始对话"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            autoFocus
            disabled={!config.enabled}
          />
          <button
            className="ai-send"
            disabled={!config.enabled || (!running && !prompt.trim())}
            onClick={running ? stop : send}
            title={running ? "停止" : "发送"}
          >
            {running ? <span className="ai-send-stop" /> : <SendIcon width={16} height={16} />}
          </button>
        </div>
      </div>

      {settingsOpen && <AiSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="ai-think">
      <summary className="ai-think-summary">已深度思考</summary>
      <div className="ai-think-body">{text}</div>
    </details>
  );
}
