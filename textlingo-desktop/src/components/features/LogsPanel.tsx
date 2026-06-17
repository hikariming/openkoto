import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { RefreshCw, Trash2, Copy, Download, Play, Pause } from "lucide-react";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

const SOURCES = ["all", "pdf", "python", "rust", "frontend"] as const;
const LEVELS = ["all", "debug", "info", "warn", "error"] as const;

const LEVEL_CLASSES: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-yellow-600 dark:text-yellow-400",
  error: "text-destructive",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function entriesToText(entries: LogEntry[]): string {
  return entries
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] [${e.source}] ${e.message}`)
    .join("\n");
}

export function LogsPanel() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [source, setSource] = useState<string>("all");
  const [level, setLevel] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Keep the latest filter values available to the polling callback without
  // re-creating the interval on every keystroke.
  const filtersRef = useRef({ source, level, search });
  filtersRef.current = { source, level, search };

  const refresh = useCallback(async () => {
    try {
      const { source: src, level: lvl, search: q } = filtersRef.current;
      const result = await invoke<LogEntry[]>("get_logs_cmd", {
        source: src,
        level: lvl,
        search: q,
        limit: 3000,
      });
      setLogs(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Initial load + refresh immediately whenever filters change.
  useEffect(() => {
    void refresh();
  }, [refresh, source, level, search]);

  // Auto-refresh loop.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  // Auto-scroll to the newest line, but only if the user is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const handleClear = async () => {
    try {
      await invoke("clear_logs_cmd");
      setLogs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entriesToText(logs));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExport = async () => {
    try {
      const path = await invoke<string | null>("get_log_file_path_cmd");
      const dest = await save({
        defaultPath: "openkoto-logs.log",
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      });
      if (!dest) return;
      if (path) {
        // Export the full on-disk history (not just the filtered view).
        await invoke("export_file_cmd", { srcPath: path, destPath: dest });
      } else {
        // Fallback: write the current in-memory view.
        await invoke("write_text_file", { path: dest, content: entriesToText(logs) });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const lastEntry = logs[logs.length - 1];

  return (
    <div className="flex h-full flex-col space-y-4">
      <div>
        <h3 className="text-lg font-medium text-foreground">{t("settings.logs.title", "Logs")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "settings.logs.description",
            "Detailed logs from the app, the PDF sidecar (Python), and the UI. Use this to diagnose stuck translations.",
          )}
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="h-8 w-auto text-xs">
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? t("settings.logs.allSources", "All sources") : s}
            </option>
          ))}
        </Select>
        <Select value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 w-auto text-xs">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === "all" ? t("settings.logs.allLevels", "All levels") : l}
            </option>
          ))}
        </Select>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.logs.searchPlaceholder", "Filter text...")}
          className="h-8 flex-1 min-w-[8rem] text-xs"
        />
        <Button
          type="button"
          variant={autoRefresh ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setAutoRefresh((v) => !v)}
          className="h-8 gap-1 px-2 text-xs"
          title={t("settings.logs.autoRefresh", "Auto-refresh")}
        >
          {autoRefresh ? <Pause size={13} /> : <Play size={13} />}
          {t("settings.logs.autoRefresh", "Auto-refresh")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} className="h-8 w-8 p-0" title={t("settings.logs.refresh", "Refresh")}>
          <RefreshCw size={14} />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleCopy} className="h-8 w-8 p-0" title={t("settings.logs.copy", "Copy")}>
          <Copy size={14} />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleExport} className="h-8 w-8 p-0" title={t("settings.logs.export", "Export")}>
          <Download size={14} />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleClear} className="h-8 w-8 p-0 text-destructive hover:text-destructive/80" title={t("settings.logs.clear", "Clear")}>
          <Trash2 size={14} />
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
      )}

      {/* Status line */}
      <div className="text-xs text-muted-foreground">
        {t("settings.logs.count", "{{count}} entries", { count: logs.length })}
        {lastEntry && ` · ${t("settings.logs.lastAt", "last")} ${formatTime(lastEntry.ts)}`}
      </div>

      {/* Log viewer */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-[16rem] flex-1 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            {t("settings.logs.empty", "No logs yet. Run a PDF translation to capture detailed logs here.")}
          </div>
        ) : (
          logs.map((e) => (
            <div key={e.id} className="whitespace-pre-wrap break-words">
              <span className="text-muted-foreground">{formatTime(e.ts)}</span>{" "}
              <span className={`font-semibold ${LEVEL_CLASSES[e.level]}`}>{e.level.toUpperCase()}</span>{" "}
              <span className="text-primary">[{e.source}]</span>{" "}
              <span className={LEVEL_CLASSES[e.level]}>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
