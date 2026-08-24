import { useState } from "react";
import { useAiStore } from "../store/ai";
import { SparkleIcon } from "./icons";
import { AiSettingsDialog } from "./AiSettingsDialog";

// Floating AI assistant. Entry points (NewPageGuide, sidebar, command palette)
// open it via store.setOpen(true). It renders a docked panel bottom-right with a
// prompt box; the model's writes surface as draft cards the user must confirm.
export function AiAssistantPanel() {
  const { config, open, running, reply, drafts, error, setOpen, run, confirm, dismiss, clearResult, resetError } =
    useAiStore();
  const [prompt, setPrompt] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!config.enabled) return null;

  const send = async () => {
    const p = prompt.trim();
    if (!p || running) return;
    setPrompt("");
    await run(p);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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
          <button className="ai-header-btn ai-settings" title="设置" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          <button className="ai-header-btn ai-close" title="关闭" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="ai-body">
          {reply && (
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

          {drafts.length > 0 && (
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

          {error && (
            <div className="ai-error" onClick={resetError}>
              <span>{error}</span>
              <button className="ai-error-close" title="关闭">×</button>
            </div>
          )}

          {!reply && drafts.length === 0 && !error && (
            <div className="ai-empty">
              询问笔记内容，或让我新建页面、追加内容。写入前需你确认。
            </div>
          )}
        </div>

        <div className="ai-input-row">
          <textarea
            className="ai-textarea"
            placeholder="向 AI 提问或下达指令…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            autoFocus
          />
          <button className="ai-send" disabled={running || !prompt.trim()} onClick={send}>
            {running ? "思考中…" : "发送"}
          </button>
        </div>
      </div>

      {settingsOpen && <AiSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
