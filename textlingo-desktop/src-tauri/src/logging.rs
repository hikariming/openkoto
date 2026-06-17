//! Global application log store.
//!
//! Captures logs from every layer of the app — the Rust backend, the Python
//! PDF sidecar (via its stdout/stderr), and the frontend (pushed over a Tauri
//! command) — into a single in-memory ring buffer that is also mirrored to a
//! file on disk. The Settings → Logs panel reads from here. This exists mainly
//! to debug the PDF translation pipeline, where a stall is invisible without a
//! timestamped, cross-layer trace.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Keep the in-memory buffer bounded so a long-running session can't grow
/// without limit. The on-disk file keeps the full history.
const MAX_ENTRIES: usize = 20_000;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }

    /// Severity rank used for `min_level` filtering (higher = more severe).
    fn rank(self) -> u8 {
        match self {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
        }
    }

    /// Parse a level from a string, defaulting to `Info` for anything unknown.
    pub fn parse(value: &str) -> LogLevel {
        match value.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => LogLevel::Debug,
            "warn" | "warning" => LogLevel::Warn,
            "error" | "err" | "fatal" => LogLevel::Error,
            _ => LogLevel::Info,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct LogEntry {
    /// Monotonic id, lets the frontend poll incrementally (`after_id`).
    pub id: u64,
    /// Epoch milliseconds.
    pub ts: i64,
    pub level: LogLevel,
    /// Origin of the log: "rust", "pdf", "python", "frontend", ...
    pub source: String,
    pub message: String,
}

struct Inner {
    buffer: VecDeque<LogEntry>,
    next_id: u64,
    file: Option<File>,
    file_path: Option<PathBuf>,
}

pub struct LogStore {
    inner: Mutex<Inner>,
}

static STORE: OnceLock<LogStore> = OnceLock::new();

impl LogStore {
    /// The process-wide log store. Usable from any thread without an
    /// `AppHandle`, which matters because the sidecar reader threads log here.
    pub fn global() -> &'static LogStore {
        STORE.get_or_init(|| LogStore {
            inner: Mutex::new(Inner {
                buffer: VecDeque::with_capacity(1024),
                next_id: 1,
                file: None,
                file_path: None,
            }),
        })
    }

    /// Point the store at `<app_data_dir>/logs/openkoto.log` for persistence.
    /// Safe to call once at startup; failures are non-fatal (memory still works).
    pub fn init_file(&self, app_data_dir: &std::path::Path) {
        let logs_dir = app_data_dir.join("logs");
        if std::fs::create_dir_all(&logs_dir).is_err() {
            return;
        }
        let path = logs_dir.join("openkoto.log");
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
            let mut inner = self.inner.lock().unwrap();
            inner.file = Some(file);
            inner.file_path = Some(path);
        }
        self.push(
            LogLevel::Info,
            "rust",
            "=== log store initialized (new app session) ===",
        );
    }

    pub fn file_path(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .file_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    }

    /// Append a log entry to the buffer and the file.
    pub fn push(&self, level: LogLevel, source: &str, message: impl Into<String>) {
        let message = message.into();
        let ts = chrono::Utc::now().timestamp_millis();
        let mut inner = self.inner.lock().unwrap();

        if let Some(file) = inner.file.as_mut() {
            let line = format!(
                "{} [{:<5}] [{}] {}\n",
                chrono::Utc::now().to_rfc3339(),
                level.as_str(),
                source,
                message
            );
            let _ = file.write_all(line.as_bytes());
        }

        let id = inner.next_id;
        inner.next_id += 1;
        inner.buffer.push_back(LogEntry {
            id,
            ts,
            level,
            source: source.to_string(),
            message,
        });
        while inner.buffer.len() > MAX_ENTRIES {
            inner.buffer.pop_front();
        }
    }

    /// Filtered snapshot of recent entries (oldest → newest within the window).
    pub fn entries(
        &self,
        source: Option<&str>,
        min_level: Option<LogLevel>,
        search: Option<&str>,
        after_id: Option<u64>,
        limit: usize,
    ) -> Vec<LogEntry> {
        let inner = self.inner.lock().unwrap();
        let search_lc = search
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase());

        let mut matched: Vec<LogEntry> = inner
            .buffer
            .iter()
            .filter(|e| after_id.map(|a| e.id > a).unwrap_or(true))
            .filter(|e| source.map(|s| e.source == s).unwrap_or(true))
            .filter(|e| min_level.map(|m| e.level.rank() >= m.rank()).unwrap_or(true))
            .filter(|e| {
                search_lc
                    .as_ref()
                    .map(|q| e.message.to_ascii_lowercase().contains(q))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();

        // Keep the most recent `limit` entries while preserving chronological order.
        if matched.len() > limit {
            matched.drain(0..matched.len() - limit);
        }
        matched
    }

    /// Drop all in-memory entries and truncate the on-disk log.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.buffer.clear();
        if let Some(path) = inner.file_path.clone() {
            if let Ok(file) = OpenOptions::new().write(true).truncate(true).open(&path) {
                inner.file = Some(file);
            }
        }
    }
}

/// Convenience free function so call sites read like `logging::log(...)`.
pub fn log(level: LogLevel, source: &str, message: impl Into<String>) {
    LogStore::global().push(level, source, message);
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_logs_cmd(
    source: Option<String>,
    level: Option<String>,
    search: Option<String>,
    after_id: Option<u64>,
    limit: Option<usize>,
) -> Vec<LogEntry> {
    let src = source.as_deref().filter(|s| *s != "all" && !s.is_empty());
    let min_level = level
        .as_deref()
        .filter(|s| *s != "all" && !s.is_empty())
        .map(LogLevel::parse);
    LogStore::global().entries(
        src,
        min_level,
        search.as_deref(),
        after_id,
        limit.unwrap_or(3000),
    )
}

#[tauri::command]
pub fn clear_logs_cmd() {
    LogStore::global().clear();
}

#[tauri::command]
pub fn append_log_cmd(level: String, source: String, message: String) {
    LogStore::global().push(LogLevel::parse(&level), &source, message);
}

#[tauri::command]
pub fn get_log_file_path_cmd() -> Option<String> {
    LogStore::global().file_path()
}
