// Minimal LLM proxy. Two narrowly-scoped commands forward a chat completion (or
// a "list models" probe) to the user-configured endpoint so the DESKTOP backend
// does the HTTP request. This is what bypasses browser/WebView2 CORS for cloud
// LLMs (DeepSeek/OpenAI/…) — the frontend never fetches those origins directly.
// It exposes ONLY LLM proxying; nothing else (no shell/files/arbitrary URLs).

use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize, Serialize)]
pub struct AiMessageIn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct AiCompleteArgs {
    pub provider: String, // "ollama" | "openai"
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub messages: Vec<AiMessageIn>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AiProbeArgs {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AiNativeToolCall {
    pub name: String,
    /// Raw JSON string for the arguments (the frontend parses it).
    pub arguments: String,
}

#[derive(Debug, Serialize)]
pub struct AiCompleteResult {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_tool_calls: Option<Vec<AiNativeToolCall>>,
}

#[derive(Debug, Serialize)]
pub struct AiProbeResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<String>,
}

fn base_of(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/// OpenAI-compatible endpoints live under /v1 unless the base already ends in it.
fn append_v1(base: &str, path: &str) -> String {
    let b = base_of(base);
    if b.ends_with("/v1") {
        format!("{b}{path}")
    } else {
        format!("{b}/v1{path}")
    }
}

fn describe_net(e: &reqwest::Error, url: &str) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("无法连接到 {url}，请确认服务已启动且地址正确。")
    } else {
        format!("请求 {url} 失败：{e}")
    }
}

fn tool_calls_from(value: &serde_json::Value) -> Vec<AiNativeToolCall> {
    let mut out = Vec::new();
    for tc in value.as_array().cloned().unwrap_or_default() {
        let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        // Ollama passes arguments as an object; OpenAI passes it as a JSON string.
        // Either way, serialising the value yields a JSON string for the frontend.
        let arguments = match tc["function"]["arguments"].as_str() {
            Some(s) => s.to_string(),
            None => tc["function"]["arguments"].to_string(),
        };
        out.push(AiNativeToolCall { name, arguments });
    }
    out
}

async fn ai_ollama_complete(args: AiCompleteArgs) -> Result<AiCompleteResult, String> {
    let url = format!("{}/api/chat", base_of(&args.base_url));
    let body = json!({
        "model": args.model,
        "messages": args.messages,
        "stream": false,
        "options": {
            "num_ctx": 8192,
            "temperature": args.temperature.unwrap_or(0.7),
            "num_predict": args.max_tokens.unwrap_or(512),
        }
    });
    let resp = reqwest::Client::new().post(&url).json(&body).send().await.map_err(|e| describe_net(&e, &url))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama 请求失败 ({})，请确认本地模型服务已启动、地址正确。", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = v["message"]["content"].as_str().unwrap_or("").to_string();
    let native = tool_calls_from(&v["message"]["tool_calls"]);
    Ok(AiCompleteResult {
        content,
        native_tool_calls: if native.is_empty() { None } else { Some(native) },
    })
}

async fn ai_openai_complete(args: AiCompleteArgs) -> Result<AiCompleteResult, String> {
    let url = append_v1(&args.base_url, "/chat/completions");
    let mut req = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "model": args.model,
            "messages": args.messages,
            "stream": false,
            "temperature": args.temperature.unwrap_or(0.7),
            "max_tokens": args.max_tokens.unwrap_or(512),
        }));
    if let Some(key) = args.api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| describe_net(&e, &url))?;
    let status = resp.status();
    if !status.is_success() {
        let mut detail = String::new();
        if let Ok(v) = resp.json::<serde_json::Value>().await {
            detail = v["error"]["message"].as_str().unwrap_or("").to_string();
        }
        return Err(format!("OpenAI 兼容接口请求失败 ({status}){detail}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    let native = tool_calls_from(&v["choices"][0]["message"]["tool_calls"]);
    Ok(AiCompleteResult {
        content,
        native_tool_calls: if native.is_empty() { None } else { Some(native) },
    })
}

#[tauri::command]
pub async fn ai_complete(args: AiCompleteArgs) -> Result<AiCompleteResult, String> {
    if args.provider == "openai" {
        ai_openai_complete(args).await
    } else {
        ai_ollama_complete(args).await
    }
}

fn probe_message(models: Vec<String>, model: &str, is_ollama: bool) -> AiProbeResult {
    let installed = !models.is_empty();
    let found = models.iter().any(|m| *m == model || m.starts_with(&format!("{model}")));
    let message = if !installed {
        if is_ollama {
            format!("连接成功，但未发现任何可用模型。请先运行 ollama pull {model}。")
        } else {
            "连接成功，但未发现任何可用模型。请确认真实模型名。".to_string()
        }
    } else if found {
        format!("连接成功。模型「{model}」已可用（共 {} 个）。", models.len())
    } else {
        format!(
            "连接成功（共 {} 个模型），但「{model}」不在其中。可用：{}",
            models.len(),
            models.iter().take(8).cloned().collect::<Vec<_>>().join(", ")
        )
    };
    AiProbeResult { ok: true, message, models }
}

async fn ai_openai_probe(args: AiProbeArgs) -> Result<AiProbeResult, String> {
    let url = append_v1(&args.base_url, "/models");
    let mut req = reqwest::Client::new().get(&url);
    if let Some(key) = args.api_key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(key);
    }
    let resp = req.send().await.map_err(|e| describe_net(&e, &url))?;
    let status = resp.status();
    if status == 401 || status == 403 {
        return Err("鉴权失败（401/403）：请检查 API Key 是否正确。".to_string());
    }
    if !status.is_success() {
        return Err(format!("OpenAI 兼容接口响应异常 ({status})。"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = v["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).map(|s| s.to_string()))
        .collect();
    Ok(probe_message(models, &args.model, false))
}

async fn ai_ollama_probe(args: AiProbeArgs) -> Result<AiProbeResult, String> {
    let url = format!("{}/api/tags", base_of(&args.base_url));
    let resp = reqwest::Client::new().get(&url).send().await.map_err(|e| describe_net(&e, &url))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama 服务响应异常 ({})。", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let models = v["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
        .collect();
    Ok(probe_message(models, &args.model, true))
}

#[tauri::command]
pub async fn ai_probe(args: AiProbeArgs) -> Result<AiProbeResult, String> {
    if args.provider == "openai" {
        ai_openai_probe(args).await
    } else {
        ai_ollama_probe(args).await
    }
}
