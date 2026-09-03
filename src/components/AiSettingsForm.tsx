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

// AI 配置表单（provider / 地址 / 密钥 / 模型 / 连接测试）。
//
// 抽成独立组件是为了**一份实现两处用**：AI 助手面板里的独立对话框
// （AiSettingsDialog）和设置中心的「AI」页共用同一段表单与校验逻辑，
// 避免两处各写一份后配置项走样。
//
// - `onDone`：保存/取消后的收尾（对话框里是关闭，设置中心里可为 no-op）。
// - `showCancel`：设置中心内嵌时不需要「取消」（关掉对话框即是取消）。
export function AiSettingsForm({
  onDone,
  showCancel = true,
}: {
  onDone: () => void;
  showCancel?: boolean;
}) {
  const { config, update } = useAiStore();
  const [enabled, setEnabled] = useState(config.enabled);
  const [provider, setProvider] = useState<AiProvider>(config.provider);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [embeddingModel, setEmbeddingModel] = useState(config.embeddingModel);
  // 独立 embedding 服务（支持 DeepSeek 对话 + Ollama 嵌入）：空 = 复用对话配置。
  const [embedBaseUrl, setEmbedBaseUrl] = useState(config.embedBaseUrl ?? "");
  const [embedProvider, setEmbedProvider] = useState<"ollama" | "openai">(config.embedProvider ?? config.provider);
  // 语义检索区默认折叠（可选增强，不用时别占高位）；有值则默认展开。
  const [embedOpen, setEmbedOpen] = useState(!!config.embeddingModel);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

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
    update({ enabled, provider, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, embeddingModel: embeddingModel.trim(), embedBaseUrl: embedBaseUrl.trim(), embedProvider });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
    onDone();
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    setTestOk(null);
    try {
      const r = await probeApi(resolved());
      setTestOk(r.ok);
      setTestMsg(r.message);
      if (r.models?.length) setDiscoveredModels(r.models);
    } catch (e) {
      setTestOk(false);
      setTestMsg(String((e as Error)?.message ?? e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <p className="ai-settings-desc">
        Ollama 为本地模型（无需密钥）；OpenAI 兼容支持 DeepSeek 等云服务（需 API Key）。若「没生效」，先点「测试连接」确认服务和模型可达。
      </p>

      {/* ===== 分区一：AI 对话模型 ===== */}
      <div className="ai-settings-group">
        <div className="ai-settings-group-title">
          <span className="ai-settings-group-icon">💬</span>
          <span>AI 对话模型</span>
          <span className="ai-settings-group-note">用于 AI 助手 / 公式 / 摘要等</span>
        </div>

        <label className="ai-settings-row ai-settings-enable">
          <span className="ai-settings-label">启用 AI 助手</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`ui-toggle ${enabled ? "on" : ""}`}
            onClick={() => setEnabled((v) => !v)}
          >
            <span className="ui-toggle-knob" />
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
            list="ai-model-list"
          />
        </label>
        {isOpenAI && discoveredModels.length > 0 && (
          <datalist id="ai-model-list">
            {discoveredModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
      </div>

      {/* ===== 分区二：语义检索（embedding）——独立于对话模型，可折叠 ===== */}
      <div className="ai-settings-group">
        <button
          type="button"
          className="ai-settings-group-title ai-settings-collapse"
          onClick={() => setEmbedOpen((v) => !v)}
        >
          <span className="ai-settings-group-icon">🔎</span>
          <span>语义检索（embedding）</span>
          <span className="ai-settings-group-note">{embedOpen ? "点击收起" : embeddingModel ? `${embeddingModel} · 点击展开` : "未启用 · 点击展开"}</span>
        </button>

        {embedOpen && (
          <>
            <div className="ai-settings-why">
              <b>作用：</b>让搜索更聪明——不只是按关键词，而是<b>按意思</b>找出语义相关的内容。
              配了嵌入模型后，搜索会叠加「语义相关」结果（如搜「会议」也能带出「讨论安排」）。
              <span className="ai-settings-why-note">可选：不配也能用（关键词检索）；配了检索更准。需独立 embedding 服务（DeepSeek 无此接口）。</span>
            </div>

            <label className="ai-settings-row">
              <span className="ai-settings-label">嵌入模型</span>
              <input
                className="ai-settings-input"
                value={embeddingModel}
                onChange={(e) => setEmbeddingModel(e.target.value)}
                placeholder={isOpenAI ? "text-embedding-3-small" : "nomic-embed-text"}
                spellCheck={false}
              />
            </label>

            <div className="ai-settings-card-note">默认复用上面的对话服务；也可用独立的 embedding 服务（如 DeepSeek 对话 + 本地 Ollama 嵌入）。</div>

            <label className="ai-settings-row">
              <span className="ai-settings-label">检索服务商</span>
              <select
                className="ai-settings-select"
                value={embedProvider}
                onChange={(e) => setEmbedProvider(e.target.value as "ollama" | "openai")}
              >
                <option value="ollama">Ollama（本地）</option>
                <option value="openai">OpenAI 兼容</option>
              </select>
            </label>
            <label className="ai-settings-row">
              <span className="ai-settings-label">嵌入地址（可选）</span>
              <input
                className="ai-settings-input"
                value={embedBaseUrl}
                onChange={(e) => setEmbedBaseUrl(e.target.value)}
                placeholder={embedProvider === "openai" ? "http://localhost:8000/v1（留空用对话地址）" : "http://localhost:11434（留空用对话地址）"}
                spellCheck={false}
              />
            </label>
          </>
        )}
      </div>

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
        {saved && <span className="ai-settings-saved">已保存</span>}
        {showCancel && (
          <button className="ai-settings-cancel" onClick={onDone}>
            取消
          </button>
        )}
        <button className="ai-settings-save" onClick={save}>
          保存
        </button>
      </div>
    </>
  );
}
