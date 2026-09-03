import { useState } from "react";
import { useAiStore } from "../store/ai";
import { probeApi } from "../lib/ai/transport";
import { embedText } from "../lib/semanticEmbed";
import {
  AI_PRESETS,
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
  const [enableEmbedding, setEnableEmbedding] = useState(config.enableEmbedding);
  const [embeddingModel, setEmbeddingModel] = useState(config.embeddingModel);
  // 独立 embedding 服务（支持 DeepSeek 对话 + Ollama 嵌入）：空 = 复用对话配置。
  const [embedBaseUrl, setEmbedBaseUrl] = useState(config.embedBaseUrl ?? "");
  const [embedProvider, setEmbedProvider] = useState<"ollama" | "openai">(config.embedProvider ?? config.provider);
  // 两个功能各自独立的测试状态（AI 助手 / 语义检索）。
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [embedTesting, setEmbedTesting] = useState(false);
  const [embedTestOk, setEmbedTestOk] = useState<boolean | null>(null);
  const [embedTestMsg, setEmbedTestMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isOpenAI = provider === "openai";

  // 选预设服务商 → 自动填 服务商/地址/模型（可再手动改）。国产优先，尤其 DeepSeek。
  const applyPreset = (id: string) => {
    const p = AI_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
  };

  // 当前地址/模型匹配某个预设时显示预设名，否则「自定义」。
  const currentPresetId =
    AI_PRESETS.find((p) => (baseUrl.trim() || p.baseUrl).replace(/\/$/, "") === p.baseUrl.replace(/\/$/, "") && model.trim() === p.model)?.id ?? "custom";

  const resolved = (): ProviderConfig => ({
    provider,
    baseUrl: (baseUrl.trim() || (isOpenAI ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL)).replace(/\/$/, ""),
    model: model.trim() || (isOpenAI ? OPENAI_COMPAT_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL),
    apiKey: apiKey.trim(),
  });

  const save = () => {
    const c = resolved();
    update({ enabled, provider, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, enableEmbedding, embeddingModel: embeddingModel.trim(), embedBaseUrl: embedBaseUrl.trim(), embedProvider });
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
    } catch (e) {
      setTestOk(false);
      setTestMsg(String((e as Error)?.message ?? e));
    } finally {
      setTesting(false);
    }
  };

  // 语义检索独立测试：用嵌入模型 embed 一次，成功即连接/模型可用。
  const testEmbed = async () => {
    setEmbedTesting(true);
    setEmbedTestMsg(null);
    setEmbedTestOk(null);
    const m = embeddingModel.trim();
    if (!m) {
      setEmbedTestOk(false);
      setEmbedTestMsg("请先填嵌入模型");
      setEmbedTesting(false);
      return;
    }
    const ep = embedProvider;
    const base = (embedBaseUrl.trim() || (ep === "openai" ? OPENAI_COMPAT_DEFAULT_BASE : OLLAMA_DEFAULT_URL)).replace(/\/$/, "");
    const vec = await embedText("测试", { provider: ep, baseUrl: base, apiKey: "", model: m });
    if (vec && vec.length > 0) {
      setEmbedTestOk(true);
      setEmbedTestMsg(`连接成功，向量维度 ${vec.length}`);
    } else {
      setEmbedTestOk(false);
      setEmbedTestMsg("连接失败：服务不可达或模型不存在");
    }
    setEmbedTesting(false);
  };

  return (
    <>
      <div className="ai-settings-cols">
        {/* ===== AI 助手（对话） ===== */}
        <div className={`ai-settings-group${enabled ? "" : " is-off"}`}>
          <div className="ai-settings-group-title">
            <span className="ai-settings-group-icon">💬</span>
            <span>AI 助手</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              className={`ui-toggle ${enabled ? "on" : ""}`}
              onClick={() => setEnabled((v) => !v)}
            >
              <span className="ui-toggle-knob" />
            </button>
          </div>

          <p className="ai-settings-brief">聊天问答、写文案、做摘要。需配置对话模型。</p>

          <label className="ai-settings-row">
            <span className="ai-settings-label">服务商</span>
            <select
              className="ai-settings-select"
              value={currentPresetId}
              onChange={(e) => applyPreset(e.target.value)}
            >
              {AI_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.needsKey ? "" : "（本地）"}
                </option>
              ))}
              <option value="custom">自定义</option>
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
        </div>

        {/* ===== 语义检索 ===== */}
        <div className={`ai-settings-group${enableEmbedding ? "" : " is-off"}`}>
          <div className="ai-settings-group-title">
            <span className="ai-settings-group-icon">🔎</span>
            <span>语义检索</span>
            <button
              type="button"
              role="switch"
              aria-checked={enableEmbedding}
              className={`ui-toggle ${enableEmbedding ? "on" : ""}`}
              onClick={() => setEnableEmbedding((v) => !v)}
            >
              <span className="ui-toggle-knob" />
            </button>
          </div>

          <p className="ai-settings-brief">搜索时按「意思」找相关笔记，不只认字。需配置嵌入模型。</p>

          <label className="ai-settings-row">
            <span className="ai-settings-label">嵌入模型</span>
            <input
              className="ai-settings-input"
              value={embeddingModel}
              onChange={(e) => setEmbeddingModel(e.target.value)}
              placeholder={embedProvider === "openai" ? "text-embedding-3-small" : "dmeta-embedding-zh"}
              spellCheck={false}
            />
          </label>

          <label className="ai-settings-row">
            <span className="ai-settings-label">服务</span>
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
            <span className="ai-settings-label">服务地址</span>
            <input
              className="ai-settings-input"
              value={embedBaseUrl}
              onChange={(e) => setEmbedBaseUrl(e.target.value)}
              placeholder={embedProvider === "openai" ? "http://localhost:8000/v1（留空用上方地址）" : "http://localhost:11434（留空用上方地址）"}
              spellCheck={false}
            />
          </label>

          <div className="ai-settings-test">
            <button className="ai-settings-test-btn" onClick={testEmbed} disabled={embedTesting}>
              {embedTesting ? "测试中…" : "测试连接"}
            </button>
            {embedTestMsg && (
              <div className={`ai-settings-test-msg ${embedTestOk ? "ok" : embedTestOk === false ? "bad" : ""}`}>
                {embedTestMsg}
              </div>
            )}
          </div>
        </div>
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
