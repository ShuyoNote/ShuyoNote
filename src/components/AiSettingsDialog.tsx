import { useState } from "react";
import { useAiStore } from "../store/ai";
import { probeApi } from "../lib/ai/transport";
import {
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_URL,
  OPENAI_COMPAT_DEFAULT_BASE,
  OPENAI_COMPAT_DEFAULT_MODEL,
  type AiProvider,
  type ProviderConfig,
} from "../lib/ai/llm";

// Configure the AI feature: enable/disable + provider (local Ollama, or an
// OpenAI-compatible cloud like DeepSeek that needs an API key).
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const { config, update } = useAiStore();
  const [enabled, setEnabled] = useState(config.enabled);
  const [provider, setProvider] = useState<AiProvider>(config.provider);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const isOpenAI = provider === "openai";

  // When switching provider, swap the default base/model rather than leaving the
  // other provider's placeholder in place.
  const switchProvider = (next: AiProvider) => {
    setProvider(next);
    if (next === "openai") {
      if (baseUrl === OLLAMA_DEFAULT_URL) setBaseUrl(OPENAI_COMPAT_DEFAULT_BASE);
      if (model === OLLAMA_DEFAULT_MODEL) setModel(OPENAI_COMPAT_DEFAULT_MODEL);
    } else {
      if (baseUrl === OPENAI_COMPAT_DEFAULT_BASE) setBaseUrl(OLLAMA_DEFAULT_URL);
      if (model === OPENAI_COMPAT_DEFAULT_MODEL) setModel(OLLAMA_DEFAULT_MODEL);
    }
  };

  const resolved = (): ProviderConfig => ({
    provider,
    baseUrl: (baseUrl.trim() || (isOpenAI ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL)).replace(/\/$/, ""),
    model: model.trim() || (isOpenAI ? OPENAI_COMPAT_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL),
    apiKey: apiKey.trim(),
  });

  const save = () => {
    const c = resolved();
    update({ enabled, provider, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey });
    onClose();
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    setTestOk(null);
    try {
      const r = await probeApi(resolved());
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
          Ollama 为本地模型（无需密钥）；OpenAI 兼容支持 DeepSeek 等云服务（需 API Key）。若「没生效」，先点「测试连接」确认服务和模型可达。
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
          <span className="ai-settings-label">服务商</span>
          <select
            className="ai-settings-select"
            value={provider}
            onChange={(e) => switchProvider(e.target.value as AiProvider)}
          >
            <option value="ollama">Ollama（本地）</option>
            <option value="openai">OpenAI 兼容（DeepSeek 等）</option>
          </select>
        </label>

        <label className="ai-settings-row">
          <span className="ai-settings-label">服务地址</span>
          <input
            className="ai-settings-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={isOpenAI ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL}
            spellCheck={false}
          />
        </label>

        {isOpenAI && (
          <label className="ai-settings-row">
            <span className="ai-settings-label">API Key</span>
            <input
              className="ai-settings-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        )}

        <label className="ai-settings-row">
          <span className="ai-settings-label">模型</span>
          <input
            className="ai-settings-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={isOpenAI ? OPENAI_COMPAT_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL}
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
