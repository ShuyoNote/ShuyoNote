import { useState } from "react";
import { useAiStore } from "../store/ai";
import { OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from "../lib/ai/llm";

// Configure the AI feature: enable/disable + local model endpoint. Defaults are
// Off and a local Ollama endpoint (no cloud, no API key required).
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const { config, update } = useAiStore();
  const [enabled, setEnabled] = useState(config.enabled);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);

  const save = () => {
    update({
      enabled,
      provider: "ollama",
      baseUrl: baseUrl.trim() || OLLAMA_DEFAULT_URL,
      model: model.trim() || OLLAMA_DEFAULT_MODEL,
    });
    onClose();
  };

  return (
    <div
      className="ai-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ai-settings">
        <div className="ai-settings-title">AI 设置</div>
        <p className="ai-settings-desc">
          配置后可在助手面板中与笔记对话。功能默认关闭；只调用你配置的本地模型服务。
        </p>

        <label className="ai-settings-row ai-settings-enable">
          <span className="ai-settings-label">启用 AI 助手</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`ai-toggle ${enabled ? "on" : ""}`}
            onClick={() => setEnabled((v) => !v)}
          >
            <span className="ai-toggle-knob" />
          </button>
        </label>

        <label className="ai-settings-row">
          <span className="ai-settings-label">服务地址</span>
          <input
            className="ai-settings-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={OLLAMA_DEFAULT_URL}
            spellCheck={false}
          />
        </label>

        <label className="ai-settings-row">
          <span className="ai-settings-label">模型</span>
          <input
            className="ai-settings-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={OLLAMA_DEFAULT_MODEL}
            spellCheck={false}
          />
        </label>

        <div className="ai-settings-actions">
          <button className="ai-settings-cancel" onClick={onClose}>
            取消
          </button>
          <button className="ai-settings-save" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
