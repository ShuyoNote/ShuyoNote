import { useState } from "react";
import { useAiStore } from "../store/ai";
import { probeApi } from "../lib/ai/transport";
import { embedText } from "../lib/semanticEmbed";
import { localVision } from "../lib/ai/localVision";
import { platform } from "../lib/platform";
import { indexAvailability, runLibraryIndex, type IndexProgress } from "../lib/libraryIndexing";
import {
  AI_PRESETS,
  MODEL_OPTIONS,
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
  // 测试连接探测到的服务商模型列表 → 模型下拉从这取。
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  // 「全库索引」的运行态：进度 / 结果摘要 / 一句说明（不支持的原因 or 视觉被红线拒绝的原因）。
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [indexSummary, setIndexSummary] = useState<string | null>(null);
  const [indexNote, setIndexNote] = useState<string | null>(null);

  const indexAvail = indexAvailability(platform);

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
      // 探测结果作为模型下拉内容，并自动选中第一项。
      if (r.models?.length) {
        setDiscoveredModels(r.models);
        if (!model.trim()) setModel(r.models[0]);
      }
    } catch (e) {
      setTestOk(false);
      setTestMsg(String((e as Error)?.message ?? e));
    } finally {
      setTesting(false);
    }
  };

  // 「开始索引」：把整库内容变成可被 AI 检索的派生文本与块。
  //
  // 两件与红线有关的事，都**如实显示**而不是静默降级：
  //  · 平台不支持（移动壳等）⇒ 按钮禁用 + 说明写清；
  //  · 配的不是本机端点 ⇒ `localVision` 拒绝注入 `vision`，需要视觉的抽取器会走 `provider_error`
  //    —— 那句话直接显示给用户看（"为什么这类文件没抽出来"）。
  const runIndex = async () => {
    setIndexing(true);
    setIndexProgress(null);
    setIndexSummary(null);
    setIndexNote(null);
    try {
      const lv = localVision(resolved());
      const outcome = await runLibraryIndex({
        platform,
        ...(lv.vision ? { vision: lv.vision } : {}),
        onProgress: setIndexProgress,
      });
      if (outcome.ok) {
        setIndexSummary(outcome.summary);
        if (lv.refusal) setIndexNote(lv.refusal);
      } else {
        setIndexNote(outcome.reason);
      }
    } finally {
      setIndexing(false);
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
              list="ai-model-list"
            />
          </label>
          <datalist id="ai-model-list">
            {(discoveredModels.length ? discoveredModels : MODEL_OPTIONS[currentPresetId] ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

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

        {/* ===== 全库索引 ===== */}
        <div className="ai-settings-group">
          <div className="ai-settings-group-title">
            <span>全库索引</span>
          </div>

          <p className="ai-settings-brief">
            把已有的页面与附件抽成文本并切块 —— AI 只有索引过内容才搜得到它。
            可以重复点：已索引的部分几乎不花时间（中断后重跑也只补没做完的）。
          </p>

          <div className="ai-settings-test">
            <button className="ai-settings-test-btn" onClick={runIndex} disabled={indexing || !indexAvail.supported}>
              {indexing ? "索引中…" : "开始索引"}
            </button>
            {indexing && indexProgress && (
              <div className="ai-settings-test-msg">
                {`已处理 ${indexProgress.done} / ${indexProgress.total} · ${indexProgress.label}`}
                <div
                  aria-hidden="true"
                  style={{ marginTop: 6, height: 4, borderRadius: 2, background: "var(--border, #ddd)" }}
                >
                  <div
                    style={{
                      width: `${Math.round(indexProgress.ratio * 100)}%`,
                      height: "100%",
                      borderRadius: 2,
                      background: "var(--accent, #4c8bf5)",
                      transition: "width .15s linear",
                    }}
                  />
                </div>
              </div>
            )}
            {indexSummary && <div className="ai-settings-test-msg ok">{indexSummary}</div>}
            {!indexAvail.supported && (
              <div className="ai-settings-test-msg bad">{indexAvail.reason}</div>
            )}
            {indexNote && <div className="ai-settings-test-msg">{indexNote}</div>}
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
