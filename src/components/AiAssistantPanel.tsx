import { useState } from "react";
import { useAiStore } from "../store/ai";
import { SparkleIcon, SettingsIcon } from "./icons";
import { AiSettingsDialog } from "./AiSettingsDialog";

// Clickable quick prompts shown in the empty state, so a new user has an example
// of what to ask and the empty panel isn't a bare void.
const QUICK_PROMPTS = ["总结当前页", "新建一篇周计划", "为当前页补充提纲", "列出今日待办"];

// Floating AI assistant. Entry points (NewPageGuide, sidebar, command palette)
// open it via store.setOpen(true). It renders a docked panel bottom-right with a
// prompt box; the model's writes surface as draft cards the user must confirm.
// The floating button is ALWAYS visible (even when disabled) so a first-time user
// can reach the settings to enable AI; the panel body shows an enable notice when
// the feature is off.
export function AiAssistantPanel() {
  const { config, open, running, reply, drafts, error, setOpen, run, confirm, dismiss, clearResult, resetError } =
    useAiStore();
  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Collapsed floating toggle.
  if (!open) {
    return (
      <div className="ai-fab-wrap">
        <button
          className="ai-fab"
          title="AI 助手"
          onClick={() => setOpen(true)}
        >
          <SparkleIcon className="ai-fab-icon" />
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="ai-panel">
        <div className="ai-header">
          <SparkleIcon className="ai-header-icon" />
          <span className="ai-title">AI 助手</span>
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
                <button className="ai-reply-clear" title="清空" onClick={clearResult}>
                  清空
                </button>
              </div>
              <div className="ai-reply-text">{reply}</div>
              <div className="ai-disclaimer">由 AI 生成，仅供参考</div>
            </div>
          )}

          {config.enabled && drafts.length > 0 && (
            <div className="ai-drafts">
              <div className="ai-drafts-title">
                待确认操作（{drafts.length}）
              </div>
              {drafts.map((d) => (
                <div key={d.key} className="ai-draft-item">
                  <span className="ai-draft-summary">{d.summary}</span>
                  <div className="ai-draft-actions">
                    <button className="ai-draft-apply" onClick={() => confirm(d.key)}>
                      应用
                    </button>
                    <button className="ai-draft-discard" onClick={() => dismiss(d.key)}>
                      弃用
                    </button>
                  </div>
                </div>
              ))}
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
              <SparkleIcon className="ai-empty-icon" />
              <div className="ai-empty-text">询问笔记内容，或让我新建页面、追加内容。写入前需你确认。</div>
              <div className="ai-empty-chips">
                {QUICK_PROMPTS.map((p) => (
                  <button key={p} className="ai-chip" onClick={() => runText(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="ai-input-row">
          <textarea
            className="ai-textarea"
            placeholder={config.enabled ? "向 AI 提问或下达指令…" : "启用 AI 后可开始对话"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            autoFocus
            disabled={!config.enabled}
          />
          <button className="ai-send" disabled={!config.enabled || running || !prompt.trim()} onClick={send}>
            {running ? "思考中…" : "发送"}
          </button>
        </div>
      </div>

      {settingsOpen && <AiSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
