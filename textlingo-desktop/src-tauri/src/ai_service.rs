use crate::types::{
    AnalysisRequest, AnalysisResponse, AnalysisType, ChatRequest, ChatResponse, TranslationRequest,
    TranslationResponse,
};
use crate::moonshot::{
    is_moonshot_provider, moonshot_chat_completions_url, moonshot_files_url,
};
use futures::StreamExt;
use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};

const OPENAI_API_URL: &str = "https://api.openai.com/v1/chat/completions";
const OPENROUTER_API_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1/chat/completions";
const SILICONFLOW_API_URL: &str = "https://api.siliconflow.cn/v1/chat/completions";
const API_302AI_URL: &str = "https://api.302.ai/v1/chat/completions";
const META_API_URL: &str = "https://api.meta.ai/v1/chat/completions";
const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";

pub struct AIService {
    client: Client,
    api_key: String,
    provider: String,
    model: String,
    /// Custom base URL for openai-compatible, ollama, lmstudio providers
    base_url: Option<String>,
}

pub struct FileUploadResponse {
    pub id: String,
    pub bytes: u64,
    pub created_at: i64,
    pub filename: String,
    pub purpose: String,
}

// Default base URLs for local providers
const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434/v1/chat/completions";
const LMSTUDIO_DEFAULT_URL: &str = "http://localhost:1234/v1/chat/completions";

/// OpenRouter 之类的模型 id 会带 `vendor/` 前缀，判模型家族取最后一段。
fn canonical_model_name(model: &str) -> String {
    model.rsplit('/').next().unwrap_or(model).to_lowercase()
}

/// gpt-5 与 o 系（o1/o3/o4）推理模型只接受默认 temperature(1)，
/// 显式传其他值直接 400——这是"接 OpenAI 后翻译全部失败"的根因
/// （与 iOS `LiveChatTransport.modelRejectsCustomTemperature` 同一判据）。
/// gpt-5-chat 系是普通 chat 模型，不在此列。
fn model_rejects_custom_temperature(model: &str) -> bool {
    let name = canonical_model_name(model);
    if name.starts_with("gpt-5-chat") {
        return false;
    }
    if name.starts_with("gpt-5") {
        return true;
    }
    ["o1", "o3", "o4"]
        .iter()
        .any(|family| name == *family || name.starts_with(&format!("{}-", family)))
}

/// 一次 chat/completions 调用的结构化失败：去不去掉 temperature 重发，
/// 要看状态码与响应体，先拼成字符串就没法判了。
/// `into_message` 保持对外错误文案与旧实现逐字一致。
enum RequestFailure {
    Http { status: u16, body: String },
    Transport(String),
    Parse(String),
}

impl RequestFailure {
    fn into_message(self) -> String {
        match self {
            RequestFailure::Http { body, .. } => format!("API error: {}", body),
            RequestFailure::Transport(message) | RequestFailure::Parse(message) => message,
        }
    }
}

impl AIService {
    #[allow(dead_code)]
    pub fn new(api_key: String, provider: String, model: String) -> Self {
        Self::with_base_url(api_key, provider, model, None)
    }

    pub fn with_base_url(
        api_key: String,
        provider: String,
        model: String,
        base_url: Option<String>,
    ) -> Self {
        Self {
            client: Client::new(),
            api_key,
            provider,
            model,
            base_url,
        }
    }

    fn get_api_url(&self) -> String {
        // If custom base_url is provided, use it (append /chat/completions if needed)
        if let Some(ref url) = self.base_url {
            let trimmed = url.trim_end_matches('/');
            if trimmed.ends_with("/chat/completions") {
                return trimmed.to_string();
            } else {
                return format!("{}/chat/completions", trimmed);
            }
        }

        // Default URLs for known providers
        match self.provider.as_str() {
            "openrouter" => OPENROUTER_API_URL.to_string(),
            "deepseek" => DEEPSEEK_API_URL.to_string(),
            "siliconflow" => SILICONFLOW_API_URL.to_string(),
            "302ai" => API_302AI_URL.to_string(),
            "meta" => META_API_URL.to_string(),
            "google" | "google-ai-studio" => format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                self.model.strip_prefix("models/").unwrap_or(&self.model)
            ),
            "anthropic" => ANTHROPIC_API_URL.to_string(),
            provider if is_moonshot_provider(provider) => {
                moonshot_chat_completions_url(provider).unwrap_or_else(|| OPENAI_API_URL.to_string())
            }
            "ollama" => OLLAMA_DEFAULT_URL.to_string(),
            "lmstudio" => LMSTUDIO_DEFAULT_URL.to_string(),
            "openai-compatible" => {
                // Should not reach here if base_url is properly set
                OPENAI_API_URL.to_string()
            }
            _ => OPENAI_API_URL.to_string(),
        }
    }

    /// 检查是否为 Google 类型的 provider（需要使用 X-goog-api-key 认证）
    fn is_google_provider(&self) -> bool {
        self.provider == "google" || self.provider == "google-ai-studio"
    }

    /// OpenAI 兼容端点上该带的 temperature。
    /// - Moonshot：强制 1.0（"only 1 is allowed for this model"）；
    /// - gpt-5 / o 系推理模型：只接受默认值，显式传其他值直接 400——
    ///   字段整个不发（`None`），这是"接了 OpenAI 之后全部失败"的根因；
    /// - 其余：用请求值，默认 0.7。
    fn effective_temperature(&self, requested: Option<f32>) -> Option<f32> {
        if is_moonshot_provider(&self.provider) {
            Some(1.0)
        } else if model_rejects_custom_temperature(&self.model) {
            None
        } else {
            Some(requested.unwrap_or(0.7))
        }
    }

    fn is_anthropic_provider(&self) -> bool {
        self.provider == "anthropic"
    }

    async fn make_anthropic_request(
        &self,
        system: Option<String>,
        messages: Vec<Value>,
        temperature: Option<f32>,
    ) -> Result<String, String> {
        let mut request_body = json!({
            "model": self.model,
            "max_tokens": 8192,
            "messages": messages,
            "temperature": temperature.unwrap_or(0.7)
        });

        if let Some(sys) = system {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("system".to_string(), json!(sys));
            }
        }

        let response = self
            .client
            .post(self.get_api_url())
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Failed to send request: {}", e))?;

        if !response.status().is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Anthropic API error: {}", error_text));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        // Anthropic response: { content: [ { type: "text", text: "..." } ] }
        response_json["content"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No content in response".to_string())
    }

    async fn make_request(
        &self,
        messages: Vec<Value>,
        temperature: Option<f32>,
        enable_thinking: bool,
    ) -> Result<String, String> {
        let temp = self.effective_temperature(temperature);

        match self.send_chat_completions(&messages, temp, enable_thinking).await {
            // 中转站/自建端点背后的推理模型判不出来，只能靠 400 报错兜底：
            // 去掉 temperature 重发一次。
            Err(RequestFailure::Http { status: 400, body })
                if temp.is_some() && body.to_lowercase().contains("temperature") =>
            {
                self.send_chat_completions(&messages, None, enable_thinking)
                    .await
                    .map_err(RequestFailure::into_message)
            }
            other => other.map_err(RequestFailure::into_message),
        }
    }

    async fn send_chat_completions(
        &self,
        messages: &[Value],
        temperature: Option<f32>,
        enable_thinking: bool,
    ) -> Result<String, RequestFailure> {
        let mut request_body = json!({
            "model": self.model,
            "messages": messages,
        });
        if let Some(temp) = temperature {
            request_body["temperature"] = json!(temp);
        }

        // Moonshot specific fix: Enable thinking if requested and model supports it (like k2.5)
        if enable_thinking && is_moonshot_provider(&self.provider) && self.model.contains("k2.5") {
            if let Some(obj) = request_body.as_object_mut() {
                obj.insert("thinking".to_string(), json!({"type": "enabled"}));
            }
        }

        let mut request = self
            .client
            .post(self.get_api_url())
            .header("Content-Type", "application/json");

        // Only add Authorization header if API key is provided (local services may not need it)
        if !self.api_key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", self.api_key));
        }

        let response = request
            .json(&request_body)
            .send()
            .await
            .map_err(|e| RequestFailure::Transport(format!("Failed to send request: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(RequestFailure::Http {
                status: status.as_u16(),
                body: error_text,
            });
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| RequestFailure::Parse(format!("Failed to parse response: {}", e)))?;

        response_json["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| RequestFailure::Parse("No content in response".to_string()))
    }

    async fn make_google_request(
        &self,
        contents: Vec<Value>,
        temperature: Option<f32>,
    ) -> Result<String, String> {
        let request_body = json!({
            "contents": contents,
            "generationConfig": {
                "temperature": temperature.unwrap_or(0.7)
            }
        });

        let response = self
            .client
            .post(self.get_api_url())
            .header("Content-Type", "application/json")
            .header("X-goog-api-key", &self.api_key)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("Failed to send request: {}", e))?;

        if !response.status().is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Google API error: {}", error_text));
        }

        let response_json: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        // Google response structure: { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
        response_json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "No content in response".to_string())
    }

    pub async fn translate(
        &self,
        request: TranslationRequest,
    ) -> Result<TranslationResponse, String> {
        let system_prompt = format!(
            "You are a professional translator. Translate the following text to {}. \
            Preserve the original meaning and tone. Only return the translated text without any explanations.",
            request.target_language
        );

        let translated_text = if self.is_google_provider() {
            // 使用 Google API 格式
            let contents = vec![json!({
                "role": "user",
                "parts": [{"text": format!("{}\n\n{}", system_prompt, request.text)}]
            })];
            self.make_google_request(contents, Some(0.3)).await?
        } else if self.is_anthropic_provider() {
            let messages = vec![
                json!({"role": "user", "content": request.text.clone()}),
            ];
            self.make_anthropic_request(Some(system_prompt), messages, Some(0.3)).await?
        } else {
            let messages = vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": request.text.clone()}),
            ];
            self.make_request(messages, Some(0.3), false).await?
        };

        Ok(TranslationResponse {
            translated_text,
            original_text: request.text,
            model_used: self.model.clone(),
        })
    }

    /// 批量翻译多个文本段落（最多30条）
    /// 返回 Vec<(id, translation)>
    pub async fn batch_translate(
        &self,
        items: Vec<(String, String)>, // Vec<(id, text)>
        target_language: &str,
    ) -> Result<Vec<(String, String)>, String> {
        if items.is_empty() {
            return Ok(vec![]);
        }

        // 构建批量翻译提示词
        let mut prompt = format!(
            "将以下编号的文本翻译成{}。严格按照JSON数组格式返回，每项包含id和translation字段。\n\n",
            target_language
        );
        prompt.push_str("待翻译文本：\n");
        for (id, text) in &items {
            prompt.push_str(&format!("[{}] {}\n", id, text));
        }
        prompt.push_str("\n返回格式示例：\n");
        prompt.push_str(r#"[{"id": "xxx", "translation": "翻译结果"}, ...]"#);

        let response_text = if self.is_google_provider() {
            let contents = vec![json!({
                "role": "user",
                "parts": [{"text": prompt}]
            })];
            self.make_google_request(contents, Some(0.3)).await?
        } else if self.is_anthropic_provider() {
            let messages = vec![
                json!({"role": "user", "content": prompt}),
            ];
            self.make_anthropic_request(Some("你是专业翻译助手，将文本翻译并返回JSON格式结果。".to_string()), messages, Some(0.3)).await?
        } else {
            let messages = vec![
                json!({"role": "system", "content": "你是专业翻译助手，将文本翻译并返回JSON格式结果。"}),
                json!({"role": "user", "content": prompt}),
            ];
            self.make_request(messages, Some(0.3), false).await?
        };

        // 解析返回的 JSON 数组
        let json_str = Self::extract_json_array(&response_text);
        let parsed: Vec<Value> = serde_json::from_str(&json_str).map_err(|e| {
            format!(
                "Failed to parse batch translation response: {} - raw: {}",
                e, json_str
            )
        })?;

        let mut results = Vec::new();
        for item in parsed {
            if let (Some(id), Some(translation)) = (
                item.get("id").and_then(|v| v.as_str()),
                item.get("translation").and_then(|v| v.as_str()),
            ) {
                results.push((id.to_string(), translation.to_string()));
            }
        }

        Ok(results)
    }

    /// 从响应中提取 JSON 数组
    fn extract_json_array(content: &str) -> String {
        // 尝试提取 markdown 代码块
        if let Some(start) = content.find("```json") {
            if let Some(end) = content[start..].rfind("```") {
                if end > 7 {
                    return content[start + 7..start + end].trim().to_string();
                }
            }
        }

        if let Some(start) = content.find("```") {
            if let Some(end_offset) = content[start + 3..].find("```") {
                let end = start + 3 + end_offset;
                return content[start + 3..end].trim().to_string();
            }
        }

        // 提取 JSON 数组 (以 [ 开头)
        if let Some(start_idx) = content.find('[') {
            let mut balance = 0;
            let mut end_idx = start_idx;
            let mut found_end = false;

            for (i, c) in content[start_idx..].char_indices() {
                match c {
                    '[' => balance += 1,
                    ']' => {
                        balance -= 1;
                        if balance == 0 {
                            end_idx = start_idx + i;
                            found_end = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }

            if found_end {
                return content[start_idx..=end_idx].to_string();
            }
        }

        content.trim().to_string()
    }

    pub async fn analyze(&self, request: AnalysisRequest) -> Result<AnalysisResponse, String> {
        let system_prompt = match request.analysis_type {
            AnalysisType::Summary => {
                "Provide a concise summary of the following text in 3-5 sentences."
                    .to_string()
            }
            AnalysisType::KeyPoints => {
                "Extract and list the key points from the following text. Use bullet points."
                    .to_string()
            }
            AnalysisType::Vocabulary => {
                "Identify and explain important vocabulary words, phrases, and idioms from the following text. \
                Include definitions and example sentences."
                    .to_string()
            }
            AnalysisType::Grammar => {
                "Analyze the grammatical structures and patterns used in the following text. \
                Highlight any interesting or complex constructions."
                    .to_string()
            }
            AnalysisType::FullAnalysis => {
                "Provide a comprehensive analysis of the following text including: \
                1) Summary, 2) Key points, 3) Vocabulary highlights, 4) Grammar notes."
                    .to_string()
            }
        };

        let result = if self.is_google_provider() {
            // 使用 Google API 格式
            let contents = vec![json!({
                "role": "user",
                "parts": [{"text": format!("{}\n\n{}", system_prompt, request.text)}]
            })];
            self.make_google_request(contents, Some(0.5)).await?
        } else if self.is_anthropic_provider() {
            let messages = vec![
                json!({"role": "user", "content": request.text}),
            ];
            self.make_anthropic_request(Some(system_prompt), messages, Some(0.5)).await?
        } else {
            let messages = vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": request.text}),
            ];
            self.make_request(messages, Some(0.5), false).await?
        };

        Ok(AnalysisResponse {
            analysis_type: request.analysis_type,
            result,
            metadata: None,
        })
    }

    pub async fn chat(&self, request: ChatRequest) -> Result<ChatResponse, String> {
        if self.provider == "google" || self.provider == "google-ai-studio" {
            return self.chat_google(request).await;
        }
        if self.provider == "anthropic" {
            return self.chat_anthropic(request).await;
        }
        if is_moonshot_provider(&self.provider) {
            // Moonshot requires specific message formatting for multimedia
            let messages = self.format_messages_for_provider(&request.messages);
            return Ok(ChatResponse {
                content: self
                    .make_request(messages, request.temperature, true)
                    .await?,
                model: self.model.clone(),
                tokens_used: None,
            });
        }

        let messages: Vec<Value> = request
            .messages
            .into_iter()
            .map(|msg| {
                json!({
                    "role": msg.role,
                    "content": msg.content
                })
            })
            .collect();

        let content = self
            .make_request(messages, request.temperature, true)
            .await?;

        Ok(ChatResponse {
            content,
            model: self.model.clone(),
            tokens_used: None,
        })
    }

    // ... imports

    pub async fn stream_chat<F>(&self, request: ChatRequest, callback: F) -> Result<String, String>
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        // For now, only support standard OpenAI SSE streaming
        // Google/Anthropic streaming requires different handling, fallback to normal chat
        if self.is_google_provider() || self.is_anthropic_provider() {
            let response = self.chat(request).await?;
            callback(response.content.clone());
            return Ok(response.content);
        }

        let messages: Vec<Value> = request
            .messages
            .into_iter()
            .map(|msg| {
                json!({
                    "role": msg.role,
                    "content": msg.content
                })
            })
            .collect();

        let mut temp = self.effective_temperature(request.temperature);
        let messages = Value::Array(messages);

        let response = loop {
            let mut request_body = json!({
                "model": self.model,
                "messages": messages.clone(),
                "stream": true
            });
            if let Some(t) = temp {
                request_body["temperature"] = json!(t);
            }

            // Moonshot specific fix: Enable thinking if likely a chat (stream is usually chat)
            if is_moonshot_provider(&self.provider) && self.model.contains("k2.5") {
                if let Some(obj) = request_body.as_object_mut() {
                    obj.insert("thinking".to_string(), json!({"type": "enabled"}));
                }
            }

            let mut request_builder = self
                .client
                .post(self.get_api_url())
                .header("Content-Type", "application/json");

            if !self.api_key.is_empty() {
                request_builder =
                    request_builder.header("Authorization", format!("Bearer {}", self.api_key));
            }

            let response = request_builder
                .json(&request_body)
                .send()
                .await
                .map_err(|e| format!("Failed to send request: {}", e))?;

            if !response.status().is_success() {
                let status = response.status().as_u16();
                let error_text = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "Unknown error".to_string());
                // 推理模型只接受默认 temperature：400 点名它时去掉重发一次
                // （与 make_request 的兜底一致；SSE 的 400 发生在流开始之前，可安全重试）。
                if status == 400
                    && temp.is_some()
                    && error_text.to_lowercase().contains("temperature")
                {
                    temp = None;
                    continue;
                }
                return Err(format!("API error: {}", error_text));
            }
            break response;
        };

        let mut stream = response.bytes_stream();
        let mut full_content = String::new();

        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("Error reading stream: {}", e))?;
            let chunk_str = String::from_utf8_lossy(&chunk);

            for line in chunk_str.lines() {
                let line = line.trim();
                if line.is_empty() || !line.starts_with("data: ") {
                    continue;
                }

                let data = &line[6..];
                if data == "[DONE]" {
                    continue;
                }

                if let Ok(json) = serde_json::from_str::<Value>(data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        if !content.is_empty() {
                            full_content.push_str(content);
                            callback(content.to_string());
                        }
                    }
                }
            }
        }

        Ok(full_content)
    }

    async fn chat_google(&self, request: ChatRequest) -> Result<ChatResponse, String> {
        let contents: Vec<Value> = request
            .messages
            .into_iter()
            .map(|msg| {
                let role = if msg.role == "assistant" {
                    "model"
                } else {
                    "user"
                };

                let parts = match msg.content {
                    crate::types::ChatContent::Text(text) => vec![json!({"text": text})],
                    crate::types::ChatContent::Parts(parts) => parts
                        .into_iter()
                        .map(|part| {
                            if let Some(text) = part.text {
                                json!({"text": text})
                            } else if let Some(file) = part.file_data {
                                json!({
                                    "inlineData": {
                                        "mimeType": file.mime_type,
                                        "data": file.data
                                    }
                                })
                            } else {
                                json!({"text": ""}) // Fallback
                            }
                        })
                        .collect(),
                };

                json!({
                    "role": role,
                    "parts": parts
                })
            })
            .collect();

        let content = self
            .make_google_request(contents, request.temperature)
            .await?;

        Ok(ChatResponse {
            content,
            model: self.model.clone(),
            tokens_used: None,
        })
    }

    async fn chat_anthropic(&self, request: ChatRequest) -> Result<ChatResponse, String> {
        let mut system: Option<String> = None;
        let mut messages: Vec<Value> = Vec::new();

        for msg in request.messages {
            if msg.role == "system" {
                // Anthropic uses top-level system param instead of system role in messages
                if let crate::types::ChatContent::Text(text) = msg.content {
                    system = Some(text);
                }
                continue;
            }
            let content_value = match msg.content {
                crate::types::ChatContent::Text(text) => json!(text),
                crate::types::ChatContent::Parts(parts) => {
                    let json_parts: Vec<Value> = parts
                        .into_iter()
                        .map(|part| {
                            if let Some(text) = part.text {
                                json!({"type": "text", "text": text})
                            } else if let Some(image) = part.image_url {
                                // Anthropic image format
                                json!({
                                    "type": "image",
                                    "source": {
                                        "type": "url",
                                        "url": image.url
                                    }
                                })
                            } else {
                                json!({"type": "text", "text": ""})
                            }
                        })
                        .collect();
                    json!(json_parts)
                }
            };
            messages.push(json!({
                "role": msg.role,
                "content": content_value
            }));
        }

        let content = self
            .make_anthropic_request(system, messages, request.temperature)
            .await?;

        Ok(ChatResponse {
            content,
            model: self.model.clone(),
            tokens_used: None,
        })
    }

    // Helper to format messages for different providers
    fn format_messages_for_provider(&self, messages: &[crate::types::ChatMessage]) -> Vec<Value> {
        messages
            .iter()
            .map(|msg| {
                let content_value = match &msg.content {
                    crate::types::ChatContent::Text(text) => json!(text),
                    crate::types::ChatContent::Parts(parts) => {
                        let json_parts: Vec<Value> = parts
                            .iter()
                            .map(|part| {
                                if let Some(text) = &part.text {
                                    json!({ "type": "text", "text": text })
                                } else if let Some(video) = &part.video_url {
                                    // Kimi format: { "type": "video_url", "video_url": { "url": ... } }
                                    json!({
                                        "type": "video_url",
                                        "video_url": { "url": video.url }
                                    })
                                } else if let Some(image) = &part.image_url {
                                    json!({
                                        "type": "image_url",
                                        "image_url": { "url": image.url }
                                    })
                                } else {
                                    json!({ "type": "text", "text": "" })
                                }
                            })
                            .collect();
                        json!(json_parts)
                    }
                };

                json!({
                    "role": msg.role,
                    "content": content_value
                })
            })
            .collect()
    }

    pub async fn segment_translate_explain(
        &self,
        text: String,
        target_language: String,
    ) -> Result<crate::types::SegmentExplanation, String> {
        println!(
            "Starting segment_translate_explain for text: '{}'...",
            text.chars().take(50).collect::<String>()
        );
        let native_language_name = match target_language.as_str() {
            "zh" | "zh-CN" => "中文",
            "zh-TW" => "繁體中文",
            "en" => "English",
            "ja" => "Japanese",
            "ko" => "Korean",
            "es" => "Español",
            "fr" => "Français",
            "de" => "Deutsch",
            "ru" => "Русский",
            "ar" => "العربية",
            _ => "中文",
        };

        let system_prompt = format!(
            r#"You are a professional language learning assistant. The user's native language is {0}. Please analyze the following text segment comprehensively and return the result strictly in the following JSON format. Do NOT add any extra explanations or markdown formatting outside the JSON block.

User's Native Language: {0}

Text to Analyze:
---
{1}
---

Please strictly adhere to this JSON structure (all keys must be in English):
{{
  "translation": "Translate the text into natural, fluent {0}",
  "explanation": "Explain the text in {0}, covering context, tone, and cultural background. Use Markdown formatting.",
  "vocabulary": [
    {{
      "word": "The word or phrase from the text",
      "reading": "Pronunciation/Reading (e.g., Hiragana for Japanese, IPA for English)",
      "meaning": "Core meaning in the context, explained in {0}",
      "usage": "Usage notes and collocations in {0}",
      "example": "Example sentence containing the word, with {0} translation"
    }}
  ],
  "grammar_points": [
    {{
      "point": "Name of the grammar point",
      "explanation": "Detailed explanation in {0}",
      "example": "Example sentence using the grammar point, with {0} translation"
    }}
  ],
  "cultural_context": "Cultural background info in {0} (if applicable, else null)",
  "difficulty_level": "beginner | intermediate | advanced",
  "learning_tips": "Learning advice for this segment in {0}"
}}

Ensure all explanations, meanings, and descriptive text are written in {0}."#,
            native_language_name, text
        );

        let messages = vec![
            json!({"role": "system", "content": system_prompt.clone()}),
            json!({"role": "user", "content": format!("Analyze this: {}", text)}),
        ];

        println!("Sending request to AI provider: {}", self.provider);
        let content = if self.is_google_provider() {
            // 使用 Google API 格式
            let contents = vec![json!({
                "role": "user",
                "parts": [{"text": format!("{}\n\nAnalyze this: {}", system_prompt, text)}]
            })];
            self.make_google_request(contents, Some(0.3)).await?
        } else if self.is_anthropic_provider() {
            let anthropic_messages = vec![
                json!({"role": "user", "content": format!("Analyze this: {}", text)}),
            ];
            self.make_anthropic_request(Some(system_prompt), anthropic_messages, Some(0.3)).await?
        } else {
            self.make_request(messages, Some(0.3), false).await?
        };
        println!(
            "Received response from AI provider. Content length: {}",
            content.len()
        );

        // Robust JSON extraction
        let json_str = Self::extract_json(&content);
        println!("Extracted JSON candidate length: {}", json_str.len());

        // Try parsing, with repair fallback
        match serde_json::from_str::<crate::types::SegmentExplanation>(&json_str) {
            Ok(explanation) => {
                println!("Successfully parsed explanation JSON.");
                Ok(explanation)
            }
            Err(e) => {
                println!("Initial JSON parse failed: {}. Attempting repair...", e);
                let repaired_json = Self::repair_json(&json_str);
                match serde_json::from_str::<crate::types::SegmentExplanation>(&repaired_json) {
                    Ok(explanation) => {
                        println!("Successfully parsed repaired JSON.");
                        Ok(explanation)
                    }
                    Err(e2) => {
                        println!("Failed to parse repaired JSON: {}.", e2);
                        println!("Original content: {}", content);
                        Err(format!(
                            "Failed to parse AI response. Error: {}. Content: {}",
                            e2, repaired_json
                        ))
                    }
                }
            }
        }
    }

    /// Upload a file to the API provider (currently supports Moonshot)
    pub async fn upload_file(
        &self,
        file_path: &std::path::Path,
    ) -> Result<FileUploadResponse, String> {
        if !is_moonshot_provider(&self.provider) {
            return Err("File upload currently only supported for Moonshot provider".to_string());
        }

        let file_name = file_path
            .file_name()
            .ok_or("Invalid file name")?
            .to_string_lossy()
            .to_string();

        let file_content =
            std::fs::read(file_path).map_err(|e| format!("Failed to read file: {}", e))?;

        let mime_type = match std::path::Path::new(&file_name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
        {
            Some(ext) if ext == "mp4" => "video/mp4",
            Some(ext) if ext == "mp3" => "audio/mpeg",
            Some(ext) if ext == "wav" => "audio/wav",
            Some(ext) if ext == "m4a" => "audio/mp4",
            Some(ext) if ext == "aac" => "audio/aac",
            Some(ext) if ext == "flac" => "audio/flac",
            Some(ext) if ext == "pdf" => "application/pdf",
            Some(ext) if ext == "doc" || ext == "docx" => "application/msword",
            Some(ext) if ext == "txt" => "text/plain",
            _ => "application/octet-stream",
        };

        let part = reqwest::multipart::Part::bytes(file_content)
            .file_name(file_name.clone())
            .mime_str(mime_type)
            .map_err(|e| format!("Invalid MIME type: {}", e))?;

        let form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("purpose", "file-extract"); // Moonshot requires 'file-extract' for Kimi

        let url = moonshot_files_url(&self.provider)
            .ok_or_else(|| "File upload currently only supported for Moonshot provider".to_string())?;

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Failed to upload file: {}", e))?;

        if !response.status().is_success() {
            let error_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Upload failed: {}", error_text));
        }

        let json: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse upload response: {}", e))?;

        Ok(FileUploadResponse {
            id: json["id"].as_str().unwrap_or("").to_string(),
            bytes: json["bytes"].as_u64().unwrap_or(0),
            created_at: json["created_at"].as_i64().unwrap_or(0),
            filename: json["filename"].as_str().unwrap_or("").to_string(),
            purpose: json["purpose"].as_str().unwrap_or("").to_string(),
        })
    }

    /// Extracts the likely JSON part from a string.
    /// Prioritizes code blocks, then finding the outermost matching braces.
    fn extract_json(content: &str) -> String {
        // 1. Try finding markdown code blocks explicitly
        if let Some(start) = content.find("```json") {
            if let Some(end) = content[start..].rfind("```") {
                if end > 7 {
                    // Ensure there's content between ```json and ```
                    return content[start + 7..start + end].trim().to_string();
                }
            }
        }

        // 2. Try generic code blocks
        if let Some(start) = content.find("```") {
            // Find the next ```
            if let Some(end_offset) = content[start + 3..].find("```") {
                let end = start + 3 + end_offset;
                return content[start + 3..end].trim().to_string();
            }
        }

        // 3. Robust brace counting to find the main JSON object
        if let Some(start_idx) = content.find('{') {
            let mut balance = 0;
            let mut end_idx = start_idx;
            let mut found_end = false;

            // Iterate through chars to find the matching closing brace
            for (i, c) in content[start_idx..].char_indices() {
                match c {
                    '{' => balance += 1,
                    '}' => {
                        balance -= 1;
                        if balance == 0 {
                            end_idx = start_idx + i;
                            found_end = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }

            if found_end {
                return content[start_idx..=end_idx].to_string();
            }
        }

        // 4. Fallback to just trimming
        content
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .to_string()
    }

    /// Attempts to repair common JSON errors from LLMs.
    /// Handles: unescaped newlines, unescaped quotes inside strings, trailing commas.
    fn repair_json(json_str: &str) -> String {
        let chars: Vec<char> = json_str.chars().collect();
        let len = chars.len();
        let mut repaired = String::new();
        let mut in_string = false;
        let mut i = 0;

        while i < len {
            let ch = chars[i];

            if in_string {
                if ch == '\\' {
                    // Escape sequence — copy as-is
                    repaired.push(ch);
                    i += 1;
                    if i < len {
                        repaired.push(chars[i]);
                    }
                } else if ch == '"' || ch == '\u{201d}' {
                    // Heuristic: is this a structural closing quote or content quote?
                    // In valid JSON, after a closing quote the next non-whitespace
                    // must be one of: , : } ] or EOF.
                    let mut j = i + 1;
                    while j < len && matches!(chars[j], ' ' | '\t' | '\r' | '\n') {
                        j += 1;
                    }
                    if j >= len || matches!(chars[j], ',' | ':' | '}' | ']') {
                        // Structural closing quote
                        in_string = false;
                        repaired.push('"');
                    } else {
                        // Content quote inside string value — escape it
                        repaired.push_str("\\\"");
                    }
                } else if ch == '\n' {
                    repaired.push_str("\\n");
                } else if ch == '\r' {
                    // skip
                } else {
                    repaired.push(ch);
                }
            } else {
                // Outside string: ASCII " or smart left quote as opening quote
                if ch == '"' || ch == '\u{201c}' {
                    in_string = true;
                    repaired.push('"');
                } else {
                    repaired.push(ch);
                }
            }

            i += 1;
        }

        // Remove trailing commas
        if let Ok(re) = Regex::new(r",(\s*\})") {
            repaired = re.replace_all(&repaired, "$1").to_string();
        }
        if let Ok(re) = Regex::new(r",(\s*\])") {
            repaired = re.replace_all(&repaired, "$1").to_string();
        }

        repaired
    }

    /// 网页素材智能清洗：让模型指出哪些行属于网页噪音（导航、广告、推荐位、评论、页脚……）。
    ///
    /// 模型只返回行号，不返回改写后的正文。学习素材必须和原文逐字一致，
    /// 让模型整篇重写既费 token，又有漏字/改写/幻觉的风险。
    ///
    /// `lines` 是 (行号, 预览文本) 列表，预览文本由调用方截断；
    /// 返回 (需要删除的行号, 模型给出的干净标题)。
    pub async fn detect_web_noise_lines(
        &self,
        lines: &[(usize, String)],
        want_title: bool,
    ) -> Result<(Vec<usize>, Option<String>), String> {
        if lines.is_empty() {
            return Ok((Vec::new(), None));
        }

        let numbered = lines
            .iter()
            .map(|(idx, text)| format!("[{}] {}", idx, text))
            .collect::<Vec<_>>()
            .join("\n");

        let schema = if want_title {
            r#"{"drop": [2, 5, 6], "title": "the clean article title, or an empty string if unclear"}"#
        } else {
            r#"{"drop": [2, 5, 6]}"#
        };

        let system_prompt = format!(
            r#"You are cleaning a web page that was converted to plain text, so it can be used as language-learning material.

You will receive numbered lines. Decide which lines are NOT part of the main article body.

DROP a line when it is:
- site navigation, menus, breadcrumbs, buttons, search boxes, login/subscribe prompts
- advertisements, promotional blurbs, paywall or membership pitches
- related/recommended article lists, "hot posts", tag clouds, category lists, pagination
- share widgets, like/favorite/view counters, comment threads, comment forms
- author bio boxes, editor signatures, copyright and legal footers, contact info, ICP/registration numbers
- cookie or privacy banners, app-download prompts, "click here", "read more", "back to top"
- standalone metadata that is not part of the text: bare timestamps, view counts, image credits, source attributions

KEEP a line when it is:
- the article title, headings and subheadings
- any paragraph, sentence, dialogue or list item of the main body
- lyrics, poems, quotes, or code that belong to the article
- anything you are not sure about — when in doubt, KEEP it

Rules:
- Judge each line only by whether it belongs to the article body, never by whether it is interesting or well written.
- Never rewrite, translate, summarize or reorder anything. You only report line numbers.
- Long lines are truncated for review and marked with "(len=N)", where N is the real character count. A long line is almost always body text.
- Return ONLY raw JSON, with no markdown fences and no explanation:
{schema}"#,
            schema = schema
        );

        let user_prompt = format!("Lines to review:\n{}", numbered);

        let raw = if self.is_google_provider() {
            let contents = vec![json!({
                "role": "user",
                "parts": [{"text": format!("{}\n\n{}", system_prompt, user_prompt)}]
            })];
            self.make_google_request(contents, Some(0.0)).await?
        } else if self.is_anthropic_provider() {
            let messages = vec![json!({"role": "user", "content": user_prompt})];
            self.make_anthropic_request(Some(system_prompt), messages, Some(0.0))
                .await?
        } else {
            let messages = vec![
                json!({"role": "system", "content": system_prompt}),
                json!({"role": "user", "content": user_prompt}),
            ];
            self.make_request(messages, Some(0.0), false).await?
        };

        let json_str = Self::extract_json(&raw);
        let parsed: Value = serde_json::from_str(&json_str)
            .or_else(|_| serde_json::from_str(&Self::repair_json(&json_str)))
            .map_err(|e| format!("Failed to parse cleaning response: {} - raw: {}", e, raw))?;

        let drop = parsed
            .get("drop")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
                    })
                    .map(|n| n as usize)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let title = parsed
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Ok((drop, title))
    }
}

// Simple in-memory cache for AI service instances
use std::sync::Arc;
use tokio::sync::RwLock;

// Newtype wrapper to allow Default implementation
#[derive(Clone)]
pub struct AIServiceCache(Arc<RwLock<Option<AIService>>>);

impl Default for AIServiceCache {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(None)))
    }
}

impl AIServiceCache {
    pub async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, Option<AIService>> {
        self.0.read().await
    }

    pub async fn write(&self) -> tokio::sync::RwLockWriteGuard<'_, Option<AIService>> {
        self.0.write().await
    }
}

pub async fn get_or_create_ai_service(
    cache: &AIServiceCache,
    api_key: String,
    provider: String,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    let mut cache_guard = cache.write().await;
    *cache_guard = Some(AIService::with_base_url(api_key, provider, model, base_url));
    Ok(())
}

pub async fn get_ai_service(cache: &AIServiceCache) -> Result<AIService, String> {
    let cache_guard = cache.read().await;
    cache_guard
        .as_ref()
        .map(|service| AIService {
            client: Client::new(),
            api_key: service.api_key.clone(),
            provider: service.provider.clone(),
            model: service.model.clone(),
            base_url: service.base_url.clone(),
        })
        .ok_or_else(|| "AI service not initialized".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_models_reject_custom_temperature() {
        for model in [
            "gpt-5", "gpt-5-mini", "GPT-5.2", "o1", "o1-mini", "o3-pro", "o4-mini",
            "openai/o3", "openai/gpt-5",
        ] {
            assert!(model_rejects_custom_temperature(model), "{}", model);
        }
    }

    #[test]
    fn chat_models_keep_custom_temperature() {
        // o1x/openchat：不能把碰巧以 o 开头的模型误判成推理模型。
        for model in [
            "gpt-4o", "gpt-5-chat-latest", "deepseek-chat", "openchat-3.5",
            "o1x-experimental", "kimi-k2",
        ] {
            assert!(!model_rejects_custom_temperature(model), "{}", model);
        }
    }

    #[test]
    fn effective_temperature_matrix() {
        let svc = |provider: &str, model: &str| {
            AIService::with_base_url(String::new(), provider.to_string(), model.to_string(), None)
        };
        // 推理模型：字段整个不发。
        assert_eq!(svc("openai", "gpt-5").effective_temperature(Some(0.3)), None);
        assert_eq!(svc("openrouter", "openai/o3").effective_temperature(Some(0.3)), None);
        // Moonshot：强制 1.0。
        assert_eq!(svc("moonshot", "kimi-k2.5").effective_temperature(Some(0.3)), Some(1.0));
        // 普通模型：用请求值，缺省 0.7。
        assert_eq!(svc("openai", "gpt-4o").effective_temperature(Some(0.3)), Some(0.3));
        assert_eq!(svc("deepseek", "deepseek-chat").effective_temperature(None), Some(0.7));
    }

    #[test]
    fn request_failure_messages_match_legacy_format() {
        assert_eq!(
            RequestFailure::Http { status: 400, body: "boom".into() }.into_message(),
            "API error: boom"
        );
        assert_eq!(
            RequestFailure::Parse("No content in response".into()).into_message(),
            "No content in response"
        );
    }
}
