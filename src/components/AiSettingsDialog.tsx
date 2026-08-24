import { useState } from "react";
import { useAiStore } from "../store/ai";
import { testOllamaConnection, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from "../lib/ai/llm";

// Configure the AI feature: enable/disable + local model endpoint. Defaults are
// Off and a local Ollama endpoint (no cloud, no API key required).
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const { config, update } = useAiStore();
  const [enabled, setEnabled] = useState(config.enabled);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const save = () => {
    update({
      enabled,
      provider: "ollama",
      baseUrl: baseUrl.trim() || OLLAMA_DEFAULT_URL,
      model: model.trim() || OLLAMA_DEFAULT_MODEL,
    });
    onClose();
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    setTestOk(null);
    try {
      const r = await testOllamaConnection(
        baseUrl.trim() || OLLAMA_DEFAULT_URL,
        model.trim() || OLLAMA_DEFAULT_MODEL,
      );
      setTestOk(r.ok);
      setTestMsg(r.message);
    } catch (e) {
      setTestOk(false);
      setTestMsg(String((e as Error)?.message ?? e));
    } finally {
      setTesting(false);
    }
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
          配置后可在助手面板中与笔记对话。功能默认关闭；只调用你配置的本地模型服务。若「没生效」，先点「测试连接」确认服务和模型可达。
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

        <div className="ai-settings-test">
          <button className="ai-settings-test-btn" onClick={test} disabled={testing}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          {testMsg && (
            <div className={`ai-settings-test-msg ${testOk ? "ok" : testOk === false ? "bad" : ""}`}>
              {testMsg}
            </div>
          )}
        </div>

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
