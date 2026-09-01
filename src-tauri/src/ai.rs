// Minimal LLM proxy. Two narrowly-scoped commands forward a chat completion (or
// a "list models" probe) to the user-configured endpoint so the DESKTOP backend
// does the HTTP request. This is what bypasses browser/WebView2 CORS for cloud
// LLMs (DeepSeek/OpenAI/…) — the frontend never fetches those origins directly.
// It exposes ONLY LLM proxying; nothing else (no shell/files/arbitrary URLs).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AiMessageIn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AiCompleteArgs {
    pub provider: String, // "ollama" | "openai"
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub messages: Vec<AiMessageIn>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
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

/// A reqwest client with a generous timeout so a hung LLM endpoint can't leave a
/// request (and the UI) waiting forever. LLM inference can be slow, hence 120s.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
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
    let resp = http_client()?.post(&url).json(&body).send().await.map_err(|e| describe_net(&e, &url))?;
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
    let mut req = http_client()?
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
    let mut req = http_client()?.get(&url);
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
    let resp = http_client()?.get(&url).send().await.map_err(|e| describe_net(&e, &url))?;
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

// ---- Streaming (desktop) ----
// The command spawns a task that POSTs with stream:true, reads the body's byte
// stream, and emits each content delta to a per-run event (`ai-stream:{run_id}`)
// with payload {delta} / {done}. The frontend subscribes via `platform.event.listen`.

async fn stream_model<E: Fn(String) + Send>(args: AiCompleteArgs, emit: E) -> Result<Vec<serde_json::Value>, String> {
    let is_openai = args.provider == "openai";
    let url = if is_openai {
        append_v1(&args.base_url, "/chat/completions")
    } else {
        format!("{}/api/chat", base_of(&args.base_url))
    };
    let tools = args.tools.clone();
    let mut req = http_client()?.post(&url);
    if is_openai {
        let mut body = json!({
            "model": args.model,
            "messages": args.messages,
            "stream": true,
            "temperature": args.temperature.unwrap_or(0.7),
            "max_tokens": args.max_tokens.unwrap_or(512),
        });
        if let Some(t) = &tools {
            body["tools"] = t.clone();
        }
        req = req.json(&body);
        if let Some(key) = args.api_key.filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
    } else {
        let mut body = json!({
            "model": args.model,
            "messages": args.messages,
            "stream": true,
            "options": {
                "num_ctx": 8192,
                "temperature": args.temperature.unwrap_or(0.7),
                "num_predict": args.max_tokens.unwrap_or(512),
            }
        });
        if let Some(t) = &tools {
            body["tools"] = t.clone();
        }
        req = req.json(&body);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Return the reachable error (NOT as a delta) so the frontend can
            // show an error state instead of mistaking it for model output.
            return Err(describe_net(&e, &url));
        }
    };
    if !resp.status().is_success() {
        return Err(format!("【请求失败 {}】", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut tc_frags: std::collections::HashMap<usize, (String, String)> = std::collections::HashMap::new();
    let mut use_frags = false;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => break,
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            if is_openai {
                if let Some((tok, tcs)) = openai_stream_chunk(&line) {
                    if !tok.is_empty() {
                        emit(tok);
                    }
                    if let Some(t) = tcs {
                        use_frags = true;
                        for tc in t {
                            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                            let e = tc_frags.entry(idx).or_default();
                            if tc["function"]["name"].is_string() {
                                e.0 = tc["function"]["name"].as_str().unwrap_or("").to_string();
                            }
                            if let Some(a) = tc["function"]["arguments"].as_str() {
                                e.1.push_str(a);
                            }
                        }
                    }
                }
            } else if let Some((tok, tcs)) = ollama_stream_chunk(&line) {
                if !tok.is_empty() {
                    emit(tok);
                }
                if let Some(t) = tcs {
                    tool_calls = t;
                }
            }
        }
    }

    Ok(if use_frags {
        let mut keys: Vec<usize> = tc_frags.keys().copied().collect();
        keys.sort_unstable();
        keys.into_iter()
            .filter_map(|k| {
                let (name, args) = tc_frags.get(&k)?;
                if name.is_empty() {
                    None
                } else {
                    Some(json!({ "name": name, "arguments": args }))
                }
            })
            .collect()
    } else {
        tool_calls
            .into_iter()
            .filter_map(|tc| {
                let name = tc["function"]["name"].as_str().or(tc["name"].as_str()).unwrap_or("");
                if name.is_empty() {
                    return None;
                }
                let args = match tc["function"]["arguments"].clone() {
                    serde_json::Value::String(s) => s,
                    v => v.to_string(),
                };
                Some(json!({ "name": name, "arguments": args }))
            })
            .collect()
    })
}

fn ollama_stream_chunk(line: &str) -> Option<(String, Option<Vec<serde_json::Value>>)> {
    let l = line.strip_prefix("data:").unwrap_or(line).trim();
    if l.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(l).ok()?;
    let content = v["message"]["content"]
        .as_str()
        .or(v["response"].as_str())
        .unwrap_or("")
        .to_string();
    let tcs = v["message"]["tool_calls"]
        .as_array()
        .cloned()
        .filter(|a| !a.is_empty());
    Some((content, tcs))
}

fn openai_stream_chunk(line: &str) -> Option<(String, Option<Vec<serde_json::Value>>)> {
    let l = line.strip_prefix("data:").map(str::trim).unwrap_or("");
    if l.is_empty() || l == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(l).ok()?;
    let content = v["choices"][0]["delta"]["content"].as_str().unwrap_or("").to_string();
    let tcs = v["choices"][0]["delta"]["tool_calls"]
        .as_array()
        .cloned()
        .filter(|a| !a.is_empty());
    Some((content, tcs))
}

#[tauri::command]
pub async fn ai_complete_stream(
    args: AiCompleteArgs,
    run_id: String,
    app: AppHandle,
) -> Result<(), String> {
    // Spawn so the invoke returns immediately; deltas arrive via events.
    tauri::async_runtime::spawn(async move {
        let evt = format!("ai-stream:{run_id}");
        let app_delta = app.clone();
        let evt_delta = evt.clone();
        let emit = move |t: String| {
            let _ = app_delta.emit(&evt_delta, json!({ "delta": t }));
        };
        let result = stream_model(args, emit).await;
        match result {
            Ok(tcs) => {
                let _ = app.emit(&evt, json!({ "done": true, "toolCalls": tcs }));
            }
            Err(msg) => {
                let _ = app.emit(&evt, json!({ "done": true, "error": msg }));
            }
        }
    });
    Ok(())
}
