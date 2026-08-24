import { useEffect, useMemo, useState } from "react";
import { useAiStore } from "../store/ai";
import { useRightPanel } from "../store/rightPanel";
import { useNotes } from "../store/notes";
import { SparkleIcon, SettingsIcon } from "./icons";
import { Markdown } from "./Markdown";
import { draftPreview } from "../lib/ai/preview";
import { AiSettingsDialog } from "./AiSettingsDialog";

// Context-aware one-click actions (like FlowUs/Wolai AI): they adapt to whether a
// page is open, and "换一批" rotates through a larger pool.
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

// Floating AI assistant. Entry points (NewPageGuide, sidebar, command palette)
// open it via store.setOpen(true). It renders a docked panel bottom-right with a
// prompt box; the model's writes surface as draft cards the user must confirm.
// The floating button is ALWAYS visible (even when disabled) so a first-time user
// can reach the settings to enable AI; the panel body shows an enable notice when
// the feature is off.
export function AiAssistantPanel() {
  const {
    config,
    running,
    reply,
    drafts,
    error,
    activity,
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

  // Reserve right rail space while the panel is open (content shifts, Wolai-style).
  useEffect(() => {
    document.body.classList.toggle("is-ai-open", open);
    return () => document.body.classList.remove("is-ai-open");
  }, [open]);
  const currentId = useNotes((s) => s.currentId);
  const pageOpen = Boolean(currentId);

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

  // Collapsed state: the right-edge rail (RightRail) is the launcher, so the panel
  // renders nothing until opened via the rail / sidebar / command palette.
  if (!open) return null;

  return (
    <>
      <div className="ai-panel">
        <div className="ai-header">
          <SparkleIcon className="ai-header-icon" />
          <span className="ai-title">AI 助手</span>
          <span className="ai-model" title="当前模型">{config.model}</span>
          <button className="ai-header-btn ai-settings" title="AI 设置" onClick={() => setSettingsOpen(true)} aria-label="AI 设置">
            <SettingsIcon width={15} height={15} />
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

          {config.enabled && reply && (
            <div className="ai-reply">
              <div className="ai-reply-head">
                <SparkleIcon className="ai-reply-head-icon" />
                <span className="ai-reply-label">回复</span>
                <button className="ai-reply-clear" title="清空对话" onClick={clearResult}>
                  清空
                </button>
              </div>
              <div className="ai-reply-text"><Markdown text={reply} /></div>
              {activity.length > 0 && (
                <div className="ai-activity">
                  <span className="ai-activity-label">工具</span>
                  {activity.map((a, i) => (
                    <span key={`${a.tool}-${i}`} className="ai-activity-item">{a.note}</span>
                  ))}
                </div>
              )}
              <div className="ai-disclaimer">由 AI 生成，仅供参考</div>
            </div>
          )}

          {config.enabled && drafts.length > 0 && (
            <div className="ai-drafts">
              <div className="ai-drafts-title">
                待确认操作（{drafts.length}）
              </div>
              {drafts.map((d) => {
                const preview = draftPreview(d.payload);
                return (
                  <div key={d.key} className="ai-draft-item">
                    <div className="ai-draft-main">
                      <span className="ai-draft-summary">{d.summary}</span>
                      {preview && <pre className="ai-draft-preview">{preview}</pre>}
                    </div>
                    <div className="ai-draft-actions">
                      <button className="ai-draft-apply" onClick={() => confirm(d.key)}>
                        应用
                      </button>
                      <button className="ai-draft-discard" onClick={() => dismiss(d.key)}>
                        弃用
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {config.enabled && error && (
            <div className="ai-error" onClick={resetError}>
              <span>{error}</span>
              <button className="ai-error-close" title="关闭">×</button>
            </div>
          )}

          {config.enabled && !reply && drafts.length === 0 && !error && (
            <div className="ai-empty">
              <div className="ai-welcome">
                <SparkleIcon className="ai-welcome-icon" />
                <div className="ai-welcome-text">Hi，我是 ShuyoNote 的 AI 助手。可以针对当前笔记提问，或让我新建页面、追加内容。写入前需你确认。</div>
              </div>
              <div className="ai-suggestions">
                <div className="ai-suggestions-head">
                  <span className="ai-suggestions-label">你可以试试</span>
                  <button className="ai-suggestions-shuffle" onClick={() => setSuggestionOffset((o) => o + SUGGESTION_COUNT)} title="换一批">
                    换一批
                  </button>
                </div>
                <div className="ai-suggestions-list">
                  {suggestions.map((s) => (
                    <button key={s} className="ai-chip" onClick={() => runText(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

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
          >
            {running ? "停止" : "发送"}
          </button>
        </div>
        {config.enabled && (
          <div className="ai-footer">
            <button className="ai-footer-btn" onClick={newConversation} title="开始一段新对话">
              ＋ 新会话
            </button>
            <span className="ai-footer-right">
              <span className="ai-footer-model" title="当前模型">{config.model}</span>
            </span>
          </div>
        )}
      </div>

      {settingsOpen && <AiSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
