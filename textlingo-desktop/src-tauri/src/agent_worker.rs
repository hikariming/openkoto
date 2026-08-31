use crate::book_content::resolve_mind_map_content;
use crate::commands::save_mind_map_artifact_in_dir;
use crate::moonshot::moonshot_base_url;
use crate::storage::{
    list_agent_tasks_in_dir, load_agent_task_in_dir, save_agent_task_in_dir,
    update_article_active_mind_map_artifact_in_dir,
};
use crate::types::{
    AgentTask, AgentTaskStatus, Article, Artifact, AssistantConversationMessage, MaterialSummary,
    ModelConfig,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

const WORKER_HEALTH_TIMEOUT_SECONDS: i64 = 45;
const WORKER_LOG_LIMIT: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerHealth {
    Starting,
    Healthy,
    Unhealthy,
    Stopped,
}

#[derive(Debug, Clone)]
pub struct WorkerRuntimeState {
    pub worker_session_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
}

impl Default for WorkerRuntimeState {
    fn default() -> Self {
        Self {
            worker_session_id: None,
            started_at: None,
            last_heartbeat_at: None,
        }
    }
}

impl WorkerRuntimeState {
    pub fn health(&self, now: DateTime<Utc>, timeout: Duration) -> WorkerHealth {
        if self.worker_session_id.is_none() {
            return WorkerHealth::Stopped;
        }
        match self.last_heartbeat_at {
            Some(last_heartbeat) if now - last_heartbeat <= timeout => WorkerHealth::Healthy,
            Some(_) => WorkerHealth::Unhealthy,
            None if self.started_at.is_some() => WorkerHealth::Starting,
            None => WorkerHealth::Stopped,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum WorkerEvent {
    #[serde(rename = "worker.ready")]
    WorkerReady { payload: WorkerReadyPayload },
    #[serde(rename = "task.started")]
    TaskStarted { payload: WorkerTaskStartedPayload },
    #[serde(rename = "task.progress")]
    TaskProgress { payload: WorkerTaskProgressPayload },
    #[serde(rename = "worker.heartbeat")]
    WorkerHeartbeat { payload: WorkerHeartbeatPayload },
    #[serde(rename = "task.log")]
    TaskLog { payload: WorkerTaskLogPayload },
    #[serde(rename = "task.result")]
    TaskResult { payload: WorkerTaskResultPayload },
    #[serde(rename = "task.error")]
    TaskError { payload: WorkerTaskErrorPayload },
}

impl WorkerEvent {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::WorkerReady { .. } => "worker.ready",
            Self::TaskStarted { .. } => "task.started",
            Self::TaskProgress { .. } => "task.progress",
            Self::WorkerHeartbeat { .. } => "worker.heartbeat",
            Self::TaskLog { .. } => "task.log",
            Self::TaskResult { .. } => "task.result",
            Self::TaskError { .. } => "task.error",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerTaskStartedPayload {
    pub task_id: String,
    #[allow(dead_code)]
    pub task_type: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerTaskProgressPayload {
    pub task_id: String,
    pub stage: String,
    pub progress: f64,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerHeartbeatPayload {
    pub worker_session_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerReadyPayload {
    pub worker_session_id: String,
    pub timestamp: String,
    #[allow(dead_code)]
    pub runtime: String,
    #[allow(dead_code)]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerTaskLogPayload {
    pub task_id: String,
    pub level: WorkerLogLevel,
    pub source: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerTaskResultPayload {
    pub task_id: String,
    #[serde(default = "default_worker_task_result_artifact_type")]
    pub artifact_type: String,
    pub content: Value,
}

fn default_worker_task_result_artifact_type() -> String {
    "mind_map".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerTaskErrorPayload {
    pub task_id: String,
    #[serde(default)]
    pub code: Option<String>,
    pub message: String,
    #[serde(default)]
    pub details: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkerEventEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(flatten)]
    event: WorkerEvent,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentWorkerStatusSnapshot {
    pub health: WorkerHealth,
    pub worker_session_id: Option<String>,
    pub started_at: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub logs: Vec<WorkerLogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerLogEntry {
    pub timestamp: String,
    pub level: WorkerLogLevel,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct WorkerLaunchConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub envs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeProviderConfig {
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible {
        provider: String,
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        api_key: Option<String>,
        #[serde(rename = "baseUrl")]
        base_url: String,
    },
    NativeGoogle {
        provider: String,
        model: String,
        api_key: String,
    },
    NativeAnthropic {
        provider: String,
        model: String,
        api_key: String,
    },
    Unsupported {
        provider: String,
        reason: String,
    },
}

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const LMSTUDIO_BASE_URL: &str = "http://127.0.0.1:1234/v1";

pub struct AgentWorkerManager {
    runtime_state: Arc<Mutex<WorkerRuntimeState>>,
    logs: Arc<Mutex<Vec<WorkerLogEntry>>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl Default for AgentWorkerManager {
    fn default() -> Self {
        Self {
            runtime_state: Arc::new(Mutex::new(WorkerRuntimeState::default())),
            logs: Arc::new(Mutex::new(Vec::new())),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
        }
    }
}

impl AgentWorkerManager {
    pub fn status_snapshot(&self) -> AgentWorkerStatusSnapshot {
        let state = self.runtime_state.lock().unwrap().clone();
        let logs = self.logs.lock().unwrap().clone();
        build_status_snapshot(&state, &logs, Utc::now())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.record_log(WorkerLogLevel::Info, "manager", "stopping agent worker");
        if let Some(mut child) = self.child.lock().unwrap().take() {
            child
                .kill()
                .map_err(|e| format!("Failed to stop agent worker: {}", e))?;
            let _ = child.wait();
        }
        self.stdin.lock().unwrap().take();
        *self.runtime_state.lock().unwrap() = WorkerRuntimeState::default();
        Ok(())
    }

    pub fn ensure_started(&self, app_handle: &AppHandle) -> Result<(), String> {
        if self.is_process_alive()? {
            return Ok(());
        }

        let config = resolve_worker_launch_config(app_handle)?;
        self.record_log(
            WorkerLogLevel::Info,
            "manager",
            format!(
                "starting agent worker: {} {}",
                config.program,
                config.args.join(" ")
            ),
        );
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &config.envs {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to launch agent worker: {}", e))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Agent worker stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Agent worker stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Agent worker stderr unavailable".to_string())?;

        *self.child.lock().unwrap() = Some(child);
        *self.stdin.lock().unwrap() = Some(stdin);
        *self.runtime_state.lock().unwrap() = WorkerRuntimeState {
            worker_session_id: None,
            started_at: Some(Utc::now()),
            last_heartbeat_at: None,
        };
        emit_status_snapshot(app_handle, &self.runtime_state, &self.logs);

        let data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;
        spawn_stdout_listener(
            stdout,
            app_handle.clone(),
            data_dir,
            Arc::clone(&self.runtime_state),
            Arc::clone(&self.logs),
        );
        spawn_stderr_listener(
            stderr,
            app_handle.clone(),
            Arc::clone(&self.logs),
            Arc::clone(&self.runtime_state),
        );

        Ok(())
    }

    pub fn submit_mind_map_task(
        &self,
        app_handle: &AppHandle,
        task: &AgentTask,
        article: &Article,
        provider_config: &RuntimeProviderConfig,
    ) -> Result<(), String> {
        self.ensure_started(app_handle)?;
        let mut persisted_task = task.clone();
        persisted_task.status = AgentTaskStatus::Running;
        persisted_task.stage = Some("queued".to_string());
        persisted_task.updated_at = Utc::now().to_rfc3339();
        if persisted_task.started_at.is_none() {
            persisted_task.started_at = Some(persisted_task.updated_at.clone());
        }
        let session_id = self.runtime_state.lock().unwrap().worker_session_id.clone();
        if persisted_task.worker_session_id.is_none() {
            persisted_task.worker_session_id = session_id;
        }
        save_agent_task_in_dir(
            &app_handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?,
            &persisted_task,
        )?;

        let request = build_mind_map_worker_request(&persisted_task, article, provider_config)?;
        self.record_log(
            WorkerLogLevel::Info,
            "task",
            format!(
                "submitted mind_map.generate for article {}",
                task.article_id
            ),
        );
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "Agent worker stdin is not available".to_string())?;
        writeln!(stdin, "{}", request)
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to send task to agent worker: {}", e))?;
        Ok(())
    }

    pub fn submit_assistant_turn(
        &self,
        app_handle: &AppHandle,
        task: &AgentTask,
        user_message: String,
        conversation: Vec<AssistantConversationMessage>,
        current_material: MaterialSummary,
        available_materials: Vec<MaterialSummary>,
        provider_config: &RuntimeProviderConfig,
    ) -> Result<(), String> {
        self.ensure_started(app_handle)?;
        let mut persisted_task = task.clone();
        persisted_task.status = AgentTaskStatus::Running;
        persisted_task.stage = Some("queued".to_string());
        persisted_task.updated_at = Utc::now().to_rfc3339();
        if persisted_task.started_at.is_none() {
            persisted_task.started_at = Some(persisted_task.updated_at.clone());
        }
        let session_id = self.runtime_state.lock().unwrap().worker_session_id.clone();
        if persisted_task.worker_session_id.is_none() {
            persisted_task.worker_session_id = session_id;
        }
        save_agent_task_in_dir(
            &app_handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?,
            &persisted_task,
        )?;

        let request = build_assistant_worker_request(
            &persisted_task.id,
            provider_config,
            user_message,
            conversation,
            Some(current_material),
            available_materials,
            Some(task.article_id.clone()),
            task.input.display_language.clone(),
        );
        self.record_log(
            WorkerLogLevel::Info,
            "task",
            format!("submitted assistant.agent_turn for article {}", task.article_id),
        );
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "Agent worker stdin is not available".to_string())?;
        writeln!(stdin, "{}", request)
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to send task to agent worker: {}", e))?;
        Ok(())
    }

    fn is_process_alive(&self) -> Result<bool, String> {
        let mut guard = self.child.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            return Ok(false);
        };
        match child
            .try_wait()
            .map_err(|e| format!("Failed to inspect agent worker: {}", e))?
        {
            Some(_) => {
                self.record_log(WorkerLogLevel::Warn, "manager", "agent worker exited");
                guard.take();
                self.stdin.lock().unwrap().take();
                *self.runtime_state.lock().unwrap() = WorkerRuntimeState::default();
                Ok(false)
            }
            None => Ok(true),
        }
    }

    fn record_log(
        &self,
        level: WorkerLogLevel,
        source: impl Into<String>,
        message: impl Into<String>,
    ) {
        let mut logs = self.logs.lock().unwrap();
        push_worker_log(&mut logs, level, source, message);
    }
}

pub fn push_worker_log(
    logs: &mut Vec<WorkerLogEntry>,
    level: WorkerLogLevel,
    source: impl Into<String>,
    message: impl Into<String>,
) {
    logs.push(WorkerLogEntry {
        timestamp: Utc::now().to_rfc3339(),
        level,
        source: source.into(),
        message: message.into(),
    });
    if logs.len() > WORKER_LOG_LIMIT {
        let excess = logs.len() - WORKER_LOG_LIMIT;
        logs.drain(0..excess);
    }
}

pub fn build_status_snapshot(
    runtime_state: &WorkerRuntimeState,
    logs: &[WorkerLogEntry],
    now: DateTime<Utc>,
) -> AgentWorkerStatusSnapshot {
    AgentWorkerStatusSnapshot {
        health: runtime_state.health(now, Duration::seconds(WORKER_HEALTH_TIMEOUT_SECONDS)),
        worker_session_id: runtime_state.worker_session_id.clone(),
        started_at: runtime_state.started_at.map(|value| value.to_rfc3339()),
        last_heartbeat_at: runtime_state
            .last_heartbeat_at
            .map(|value| value.to_rfc3339()),
        logs: logs.to_vec(),
    }
}

pub fn worker_event_log_entry(event: &WorkerEvent) -> Option<(WorkerLogLevel, String)> {
    match event {
        WorkerEvent::WorkerReady { payload } => Some((
            WorkerLogLevel::Info,
            format!("worker ready: {}", payload.worker_session_id),
        )),
        WorkerEvent::TaskStarted { payload } => Some((
            WorkerLogLevel::Info,
            format!("task started: {}", payload.task_id),
        )),
        WorkerEvent::TaskProgress { payload } => Some((
            WorkerLogLevel::Info,
            format!(
                "{} {}% {}",
                payload.stage,
                (payload.progress.clamp(0.0, 1.0) * 100.0).round() as i32,
                payload.message.clone().unwrap_or_default()
            )
            .trim()
            .to_string(),
        )),
        WorkerEvent::TaskResult { payload } => Some((
            WorkerLogLevel::Info,
            format!("task completed: {}", payload.task_id),
        )),
        WorkerEvent::TaskError { payload } => Some((
            WorkerLogLevel::Error,
            format!("task failed: {}", payload.message),
        )),
        WorkerEvent::TaskLog { payload } => Some((
            payload.level.clone(),
            format!("{}: {}", payload.source, payload.message),
        )),
        WorkerEvent::WorkerHeartbeat { .. } => None,
    }
}

pub fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some(OPENAI_BASE_URL),
        "openrouter" => Some(OPENROUTER_BASE_URL),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "siliconflow" => Some("https://api.siliconflow.cn/v1"),
        "302ai" => Some("https://api.302.ai/v1"),
        "ollama" => Some(OLLAMA_BASE_URL),
        "lmstudio" => Some(LMSTUDIO_BASE_URL),
        _ if moonshot_base_url(provider).is_some() => moonshot_base_url(provider),
        _ => None,
    }
}

pub fn resolve_runtime_provider_config(config: &ModelConfig) -> RuntimeProviderConfig {
    let provider = config.api_provider.clone();
    let base_url = config
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| default_base_url(&provider).map(ToOwned::to_owned));

    if provider == "google" || provider == "google-ai-studio" {
        return RuntimeProviderConfig::NativeGoogle {
            provider,
            model: config.model.clone(),
            api_key: config.api_key.clone(),
        };
    }

    if provider == "anthropic" {
        return RuntimeProviderConfig::NativeAnthropic {
            provider,
            model: config.model.clone(),
            api_key: config.api_key.clone(),
        };
    }

    if [
        "openai",
        "openai-compatible",
        "openrouter",
        "deepseek",
        "siliconflow",
        "302ai",
        "ollama",
        "lmstudio",
    ]
    .contains(&provider.as_str())
        || moonshot_base_url(&provider).is_some()
    {
        if base_url.is_some() {
            return RuntimeProviderConfig::OpenAiCompatible {
                provider,
                model: config.model.clone(),
                api_key: if config.api_key.trim().is_empty() {
                    None
                } else {
                    Some(config.api_key.clone())
                },
                base_url: base_url.expect("base_url checked"),
            };
        }
    }

    RuntimeProviderConfig::Unsupported {
        provider: provider.clone(),
        reason: format!(
            "Provider {} is not supported for the agent runtime",
            provider
        ),
    }
}

pub fn build_mind_map_worker_request(
    task: &AgentTask,
    article: &Article,
    provider_config: &RuntimeProviderConfig,
) -> Result<serde_json::Value, String> {
    let content = resolve_mind_map_content(article)?;

    Ok(serde_json::json!({
        "id": task.id,
        "type": "request",
        "method": "agent.run",
        "params": {
            "task_id": task.id,
            "task_type": "mind_map.generate",
            "provider_config": provider_config,
            "input": {
                "article_id": task.article_id,
                "display_language": task.input.display_language,
                "max_depth": task.input.max_depth,
                "mode": "balanced",
                "article_snapshot": {
                    "title": article.title,
                    "content": content,
                    "source_type": article.source_type,
                },
            }
        }
    }))
}

pub fn build_assistant_worker_request(
    task_id: &str,
    provider_config: &RuntimeProviderConfig,
    user_message: String,
    conversation: Vec<AssistantConversationMessage>,
    current_material: Option<MaterialSummary>,
    available_materials: Vec<MaterialSummary>,
    current_article_id: Option<String>,
    display_language: String,
) -> serde_json::Value {
    serde_json::json!({
        "id": task_id,
        "type": "request",
        "method": "agent.run",
        "params": {
            "task_id": task_id,
            "task_type": "assistant.agent_turn",
            "provider_config": provider_config,
            "input": {
                "user_message": user_message,
                "conversation": conversation,
                "ui_context": {
                    "current_article_id": current_article_id,
                    "display_language": display_language,
                },
                "current_material": current_material,
                "available_materials": available_materials,
            }
        }
    })
}

pub fn parse_worker_event_line(line: &str) -> Result<WorkerEvent, String> {
    let envelope: WorkerEventEnvelope =
        serde_json::from_str(line).map_err(|e| format!("Failed to parse worker event: {}", e))?;
    if envelope.message_type != "event" {
        return Err(format!(
            "Unsupported worker message type: {}",
            envelope.message_type
        ));
    }
    Ok(envelope.event)
}

pub fn apply_worker_event_in_dir(
    data_dir: &std::path::Path,
    runtime_state: &mut WorkerRuntimeState,
    event: WorkerEvent,
) -> Result<Option<Artifact>, String> {
    match event {
        WorkerEvent::WorkerReady { payload } => {
            runtime_state.worker_session_id = Some(payload.worker_session_id);
            runtime_state.last_heartbeat_at = Some(
                DateTime::parse_from_rfc3339(&payload.timestamp)
                    .map_err(|e| format!("Failed to parse ready timestamp: {}", e))?
                    .with_timezone(&Utc),
            );
            if runtime_state.started_at.is_none() {
                runtime_state.started_at = runtime_state.last_heartbeat_at;
            }
            Ok(None)
        }
        WorkerEvent::TaskStarted { payload } => {
            let mut task = load_agent_task_in_dir(data_dir, &payload.task_id)?;
            task.status = AgentTaskStatus::Running;
            task.stage = Some("started".to_string());
            task.message = Some("Agent task started".to_string());
            task.updated_at = Utc::now().to_rfc3339();
            if task.started_at.is_none() {
                task.started_at = Some(
                    DateTime::parse_from_rfc3339(&payload.timestamp)
                        .map_err(|e| format!("Failed to parse task started timestamp: {}", e))?
                        .with_timezone(&Utc)
                        .to_rfc3339(),
                );
            }
            if task.worker_session_id.is_none() {
                task.worker_session_id = runtime_state.worker_session_id.clone();
            }
            save_agent_task_in_dir(data_dir, &task)?;
            Ok(None)
        }
        WorkerEvent::WorkerHeartbeat { payload } => {
            runtime_state.worker_session_id = Some(payload.worker_session_id);
            runtime_state.last_heartbeat_at = Some(
                DateTime::parse_from_rfc3339(&payload.timestamp)
                    .map_err(|e| format!("Failed to parse heartbeat timestamp: {}", e))?
                    .with_timezone(&Utc),
            );
            if runtime_state.started_at.is_none() {
                runtime_state.started_at = runtime_state.last_heartbeat_at;
            }
            Ok(None)
        }
        WorkerEvent::TaskProgress { payload } => {
            let mut task = load_agent_task_in_dir(data_dir, &payload.task_id)?;
            if matches!(
                task.status,
                AgentTaskStatus::Succeeded
                    | AgentTaskStatus::Failed
                    | AgentTaskStatus::Cancelled
                    | AgentTaskStatus::Interrupted
            ) {
                return Ok(None);
            }
            task.status = AgentTaskStatus::Running;
            task.progress = payload.progress.clamp(0.0, 1.0);
            task.stage = Some(payload.stage);
            task.message = payload.message;
            task.updated_at = Utc::now().to_rfc3339();
            if task.started_at.is_none() {
                task.started_at = Some(task.updated_at.clone());
            }
            if task.worker_session_id.is_none() {
                task.worker_session_id = runtime_state.worker_session_id.clone();
            }
            save_agent_task_in_dir(data_dir, &task)?;
            Ok(None)
        }
        WorkerEvent::TaskLog { .. } => Ok(None),
        WorkerEvent::TaskResult { payload } => {
            let mut task = load_agent_task_in_dir(data_dir, &payload.task_id)?;
            task.status = AgentTaskStatus::Succeeded;
            task.progress = 1.0;
            task.stage = Some("done".to_string());
            task.message = Some(match task.task_type {
                crate::types::AgentTaskType::AssistantAgentTurn => "Agent turn completed".to_string(),
                _ => "Mind map generated".to_string(),
            });
            task.error = None;
            task.updated_at = Utc::now().to_rfc3339();
            task.finished_at = Some(task.updated_at.clone());
            task.worker_session_id = runtime_state.worker_session_id.clone();
            if task.started_at.is_none() {
                task.started_at = Some(task.updated_at.clone());
            }
            let artifact = if payload.artifact_type == "article_answer" {
                None
            } else {
                let artifact =
                    save_mind_map_artifact_in_dir(data_dir, &task.id, &task.article_id, payload.content)?;
                update_article_active_mind_map_artifact_in_dir(
                    data_dir,
                    &task.article_id,
                    Some(artifact.id.clone()),
                )?;
                if !task.artifact_ids.iter().any(|id| id == &artifact.id) {
                    task.artifact_ids.push(artifact.id.clone());
                }
                Some(artifact)
            };
            save_agent_task_in_dir(data_dir, &task)?;
            Ok(artifact)
        }
        WorkerEvent::TaskError { payload } => {
            let mut task = load_agent_task_in_dir(data_dir, &payload.task_id)?;
            task.status = AgentTaskStatus::Failed;
            task.error = Some(match payload.details {
                Some(details) => format!("{}: {}", payload.message, details),
                None => payload.message,
            });
            task.updated_at = Utc::now().to_rfc3339();
            task.finished_at = Some(task.updated_at.clone());
            task.worker_session_id = runtime_state.worker_session_id.clone();
            if task.started_at.is_none() {
                task.started_at = Some(task.updated_at.clone());
            }
            save_agent_task_in_dir(data_dir, &task)?;
            Ok(None)
        }
    }
}

fn extract_open_material_id(content: &Value) -> Option<String> {
    content
        .get("action")
        .and_then(|value| value.as_object())
        .filter(|action| action.get("kind").and_then(|value| value.as_str()) == Some("open_material"))
        .and_then(|action| action.get("material_id"))
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

pub fn mark_running_tasks_interrupted_in_dir(
    data_dir: &std::path::Path,
) -> Result<Vec<String>, String> {
    let task_ids = list_agent_tasks_in_dir(data_dir)?;
    let mut interrupted = Vec::new();

    for task_id in task_ids {
        let mut task = load_agent_task_in_dir(data_dir, &task_id)?;
        if matches!(
            task.status,
            AgentTaskStatus::Running | AgentTaskStatus::Queued
        ) {
            task.status = AgentTaskStatus::Interrupted;
            task.updated_at = Utc::now().to_rfc3339();
            if task.finished_at.is_none() {
                task.finished_at = Some(task.updated_at.clone());
            }
            save_agent_task_in_dir(data_dir, &task)?;
            interrupted.push(task.id.clone());
        }
    }

    Ok(interrupted)
}

pub fn resolve_worker_launch_config(app_handle: &AppHandle) -> Result<WorkerLaunchConfig, String> {
    if let Ok(program) = std::env::var("TEXTLINGO_AGENT_WORKER_PROGRAM") {
        let args = std::env::var("TEXTLINGO_AGENT_WORKER_ARGS")
            .unwrap_or_default()
            .split_whitespace()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        let cwd = std::env::var("TEXTLINGO_AGENT_WORKER_CWD")
            .map(PathBuf::from)
            .unwrap_or_else(|_| worker_project_dir());
        return Ok(WorkerLaunchConfig {
            program,
            args,
            cwd,
            envs: default_worker_envs(app_handle)?,
        });
    }

    #[cfg(debug_assertions)]
    let config = {
        let cwd = worker_project_dir();
        ensure_worker_bundle(&cwd)?;
        WorkerLaunchConfig {
            program: "node".to_string(),
            args: vec!["dist/index.js".to_string()],
            cwd,
            envs: Vec::new(),
        }
    };

    #[cfg(not(debug_assertions))]
    let config = resolve_packaged_worker_launch_config(
        &app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get app resource dir: {}", e))?,
    )?;

    let envs = config
        .envs
        .into_iter()
        .chain(default_worker_envs(app_handle)?)
        .collect();
    Ok(WorkerLaunchConfig { envs, ..config })
}

fn find_packaged_worker_entry(resource_dir: &Path) -> Result<PathBuf, String> {
    [
        resource_dir.join("resources/agent-worker/dist/index.js"),
        resource_dir.join("agent-worker/dist/index.js"),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| {
        format!(
            "Packaged agent worker is missing from '{}'; reinstall OpenKoto Desktop",
            resource_dir.display()
        )
    })
}

fn find_packaged_node_program(resource_dir: &Path) -> Result<PathBuf, String> {
    let executable_name = if cfg!(target_os = "windows") {
        "openkoto-agent-node.exe"
    } else {
        "openkoto-agent-node"
    };
    [
        resource_dir.join("binaries").join(executable_name),
        resource_dir.join(executable_name),
        resource_dir
            .parent()
            .unwrap_or(resource_dir)
            .join(executable_name),
        resource_dir
            .parent()
            .unwrap_or(resource_dir)
            .join("MacOS")
            .join(executable_name),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| {
        format!(
            "Packaged agent worker runtime is missing from '{}'; reinstall OpenKoto Desktop",
            resource_dir.display()
        )
    })
}

fn ensure_packaged_opencode_runtime(node_program: &Path) -> Result<(), String> {
    let executable_name = if cfg!(target_os = "windows") {
        "opencode.exe"
    } else {
        "opencode"
    };
    let runtime_dir = node_program.parent().unwrap_or_else(|| Path::new("."));
    if runtime_dir.join(executable_name).is_file() {
        return Ok(());
    }
    Err(format!(
        "Packaged OpenCode runtime is missing from '{}'; reinstall OpenKoto Desktop",
        runtime_dir.display()
    ))
}

fn packaged_worker_path_env(node_program: &Path) -> Result<String, String> {
    let inherited = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let runtime_dir = node_program.parent().unwrap_or_else(|| Path::new("."));
    std::env::join_paths(std::iter::once(runtime_dir.to_path_buf()).chain(inherited))
        .map_err(|e| format!("Failed to configure packaged worker PATH: {}", e))
        .map(|value| value.to_string_lossy().into_owned())
}

pub fn resolve_packaged_worker_launch_config(
    resource_dir: &Path,
) -> Result<WorkerLaunchConfig, String> {
    let worker_entry = find_packaged_worker_entry(resource_dir)?;
    let node_program = find_packaged_node_program(resource_dir)?;
    ensure_packaged_opencode_runtime(&node_program)?;
    let cwd = worker_entry
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| resource_dir.to_path_buf());
    Ok(WorkerLaunchConfig {
        program: node_program.to_string_lossy().into_owned(),
        args: vec!["dist/index.js".to_string()],
        envs: vec![("PATH".to_string(), packaged_worker_path_env(&node_program)?)],
        cwd,
    })
}

fn default_worker_envs(app_handle: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut envs = Vec::new();
    if let Ok(value) = std::env::var("TEXTLINGO_AGENT_WORKER_USE_MOCK") {
        envs.push(("TEXTLINGO_AGENT_WORKER_USE_MOCK".to_string(), value));
    }
    if let Ok(value) = std::env::var("TEXTLINGO_AGENT_MODEL") {
        envs.push(("TEXTLINGO_AGENT_MODEL".to_string(), value));
    }
    if let Ok(value) = std::env::var("TEXTLINGO_CLAUDE_CODE_PATH") {
        envs.push(("TEXTLINGO_CLAUDE_CODE_PATH".to_string(), value));
    }
    envs.push((
        "TEXTLINGO_APP_DATA_DIR".to_string(),
        app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?
            .to_string_lossy()
            .into_owned(),
    ));
    Ok(envs)
}

fn worker_project_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
        .join("agent-worker")
}

pub fn worker_bundle_is_fresh(cwd: &Path) -> Result<bool, String> {
    let dist_dir = cwd.join("dist");
    let src_dir = cwd.join("src");
    let required_outputs = [
        dist_dir.join("index.js"),
        dist_dir.join("assistantTask.js"),
        dist_dir.join("mindMapTask.js"),
        dist_dir.join("mindMapSchema.js"),
        dist_dir.join("protocol.js"),
        dist_dir.join("runtime.js"),
    ];

    if required_outputs.iter().any(|path| !path.exists()) {
        return Ok(false);
    }

    let newest_src = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read agent worker src directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("ts"))
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .max();

    let oldest_dist = required_outputs
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .min();

    match (newest_src, oldest_dist) {
        (Some(src_modified), Some(dist_modified)) => Ok(src_modified <= dist_modified),
        _ => Ok(false),
    }
}

#[cfg(debug_assertions)]
fn ensure_worker_bundle(cwd: &Path) -> Result<(), String> {
    if worker_bundle_is_fresh(cwd)? {
        return Ok(());
    }

    let status = Command::new("npm")
        .args(["run", "build"])
        .current_dir(cwd)
        .status()
        .map_err(|e| format!("Failed to build agent worker bundle: {}", e))?;
    if !status.success() {
        return Err("Failed to build agent worker bundle".to_string());
    }
    Ok(())
}

fn spawn_stdout_listener(
    stdout: impl std::io::Read + Send + 'static,
    app_handle: AppHandle,
    data_dir: PathBuf,
    runtime_state: Arc<Mutex<WorkerRuntimeState>>,
    logs: Arc<Mutex<Vec<WorkerLogEntry>>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            let event = match parse_worker_event_line(&line) {
                Ok(event) => event,
                Err(error) => {
                    {
                        let mut guard = logs.lock().unwrap();
                        push_worker_log(
                            &mut guard,
                            WorkerLogLevel::Error,
                            "stdout",
                            format!("failed to parse worker event: {}", error),
                        );
                    }
                    emit_status_snapshot(&app_handle, &runtime_state, &logs);
                    eprintln!("[AgentWorker] Failed to parse stdout line: {}", error);
                    continue;
                }
            };

            if let Some((level, message)) = worker_event_log_entry(&event) {
                let mut guard = logs.lock().unwrap();
                push_worker_log(&mut guard, level, "worker", message);
            }

            let artifact = {
                let mut state = runtime_state.lock().unwrap();
                match apply_worker_event_in_dir(&data_dir, &mut state, event.clone()) {
                    Ok(artifact) => artifact,
                    Err(error) => {
                        {
                            let mut guard = logs.lock().unwrap();
                            push_worker_log(
                                &mut guard,
                                WorkerLogLevel::Error,
                                "stdout",
                                format!("failed to apply worker event: {}", error),
                            );
                        }
                        emit_status_snapshot(&app_handle, &runtime_state, &logs);
                        eprintln!("[AgentWorker] Failed to apply worker event: {}", error);
                        continue;
                    }
                }
            };

            emit_worker_event(
                &app_handle,
                &data_dir,
                &event,
                artifact.as_ref(),
                &runtime_state,
                &logs,
            );
        }
    });
}

fn spawn_stderr_listener(
    stderr: impl std::io::Read + Send + 'static,
    app_handle: AppHandle,
    logs: Arc<Mutex<Vec<WorkerLogEntry>>>,
    runtime_state: Arc<Mutex<WorkerRuntimeState>>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(value) => {
                    {
                        let mut guard = logs.lock().unwrap();
                        push_worker_log(&mut guard, WorkerLogLevel::Warn, "stderr", value.clone());
                    }
                    emit_status_snapshot(&app_handle, &runtime_state, &logs);
                    eprintln!("[AgentWorker] {}", value)
                }
                Err(_) => break,
            }
        }
    });
}

fn emit_worker_event(
    app_handle: &AppHandle,
    data_dir: &Path,
    event: &WorkerEvent,
    artifact: Option<&Artifact>,
    runtime_state: &Arc<Mutex<WorkerRuntimeState>>,
    logs: &Arc<Mutex<Vec<WorkerLogEntry>>>,
) {
    match event {
        WorkerEvent::WorkerReady { .. } => {
            emit_status_snapshot(app_handle, runtime_state, logs);
        }
        WorkerEvent::TaskStarted { payload } => {
            if let Ok(task) = load_agent_task_in_dir(data_dir, &payload.task_id) {
                let _ = app_handle.emit("agent-task-updated", &task);
            }
        }
        WorkerEvent::TaskProgress { payload } => {
            if let Ok(task) = load_agent_task_in_dir(data_dir, &payload.task_id) {
                let progress_event = match task.task_type {
                    crate::types::AgentTaskType::AssistantAgentTurn => {
                        format!("assistant-agent-progress://{}", payload.task_id)
                    }
                    _ => format!("mind-map-progress://{}", payload.task_id),
                };
                let _ = app_handle.emit(&progress_event, &task);
                let _ = app_handle.emit("agent-task-updated", &task);
            }
        }
        WorkerEvent::TaskLog { payload } => {
            let _ = app_handle.emit(&format!("agent-task-log://{}", payload.task_id), payload);
        }
        WorkerEvent::TaskResult { payload } => {
            if let Ok(task) = load_agent_task_in_dir(data_dir, &payload.task_id) {
                match task.task_type {
                    crate::types::AgentTaskType::AssistantAgentTurn => {
                        let _ = app_handle.emit(
                            &format!("assistant-agent-result://{}", payload.task_id),
                            &payload.content,
                        );
                        if let Some(material_id) = extract_open_material_id(&payload.content) {
                            let _ = app_handle.emit(
                                "agent://open-material",
                                serde_json::json!({ "materialId": material_id }),
                            );
                        }
                    }
                    _ => {
                        let _ = app_handle.emit(
                            &format!("mind-map-finished://{}", payload.task_id),
                            &task,
                        );
                    }
                }
                let _ = app_handle.emit("agent-task-updated", &task);
            }
            if let Some(saved_artifact) = artifact {
                let _ = app_handle.emit("mind-map-artifact-saved", saved_artifact);
            }
        }
        WorkerEvent::TaskError { payload } => {
            if let Ok(task) = load_agent_task_in_dir(data_dir, &payload.task_id) {
                let error_event = match task.task_type {
                    crate::types::AgentTaskType::AssistantAgentTurn => {
                        format!("assistant-agent-error://{}", payload.task_id)
                    }
                    _ => format!("mind-map-error://{}", payload.task_id),
                };
                let _ = app_handle.emit(&error_event, &task);
                let _ = app_handle.emit("agent-task-updated", &task);
            }
        }
        WorkerEvent::WorkerHeartbeat { .. } => {
            emit_status_snapshot(app_handle, runtime_state, logs);
        }
    }
    if !matches!(
        event,
        WorkerEvent::WorkerHeartbeat { .. } | WorkerEvent::WorkerReady { .. }
    ) {
        emit_status_snapshot(app_handle, runtime_state, logs);
    }
}

fn emit_status_snapshot(
    app_handle: &AppHandle,
    runtime_state: &Arc<Mutex<WorkerRuntimeState>>,
    logs: &Arc<Mutex<Vec<WorkerLogEntry>>>,
) {
    let snapshot = {
        let state = runtime_state.lock().unwrap().clone();
        let logs = logs.lock().unwrap().clone();
        build_status_snapshot(&state, &logs, Utc::now())
    };
    let _ = app_handle.emit("agent-worker-status", snapshot);
}
