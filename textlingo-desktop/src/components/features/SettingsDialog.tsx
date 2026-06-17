import { useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Settings, Plus, Trash2, Edit2, Check, RefreshCw, Loader2, HelpCircle, Cpu, MessageSquare, SlidersHorizontal, Palette, ScrollText, X } from "lucide-react";
import { LogsPanel } from "./LogsPanel";
import { useTheme } from "../theme-provider";
import type { AppConfig, ModelConfig, PromptFeature } from "../../lib/tauri";
import {
  getKimiModelsUrl,
  isKimiProvider,
  KIMI_CHINA_PROVIDER,
  KIMI_GLOBAL_PROVIDER,
  LEGACY_KIMI_PROVIDER,
  normalizeKimiProvider,
} from "../../lib/kimiProvider";

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
}

const SUPPORTED_PROVIDERS = ["openai", "anthropic", "openrouter", "deepseek", "siliconflow", "302ai", "google", "google-ai-studio", KIMI_CHINA_PROVIDER, KIMI_GLOBAL_PROVIDER, "openai-compatible", "ollama", "lmstudio"] as const;

// Default base URLs for local providers
const DEFAULT_BASE_URLS: Record<string, string> = {
  "openai": "https://api.openai.com/v1",
  "ollama": "http://localhost:11434/v1",
  "lmstudio": "http://localhost:1234/v1",
};

const DEFAULT_BATCH_TRANSLATION_CONCURRENCY = 3;
const MIN_BATCH_TRANSLATION_CONCURRENCY = 1;
const MAX_BATCH_TRANSLATION_CONCURRENCY = 10;

function normalizeBatchTranslationConcurrency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BATCH_TRANSLATION_CONCURRENCY;
  }

  return Math.min(
    MAX_BATCH_TRANSLATION_CONCURRENCY,
    Math.max(MIN_BATCH_TRANSLATION_CONCURRENCY, Math.trunc(parsed)),
  );
}

const BUILTIN_PROMPT_FEATURE_DEFAULTS: Record<string, PromptFeature> = {
  "chat.default": {
    id: "chat.default",
    kind: "chat_default",
    name: "Default Chat",
    description: "Default reading assistant behavior",
    prompt_template:
      "You are a helpful reading assistant. Help the user understand the material, answer clearly, and prefer the target language when appropriate.",
    requires_selection: false,
    show_in_quick_actions: false,
    icon: "sparkles",
    sort_order: 0,
    enabled: true,
    is_builtin: true,
  },
  "selection.translate": {
    id: "selection.translate",
    kind: "quick_action",
    name: "Translate",
    description: "Translate the selected text",
    prompt_template: "Translate the following text to {target_language}:\n\n{text}",
    requires_selection: true,
    show_in_quick_actions: true,
    icon: "translate",
    sort_order: 10,
    enabled: true,
    is_builtin: true,
  },
  "selection.explain": {
    id: "selection.explain",
    kind: "quick_action",
    name: "Explain",
    description: "Explain the selected text",
    prompt_template: "Explain the following text in {target_language}:\n\n{text}",
    requires_selection: true,
    show_in_quick_actions: true,
    icon: "explain",
    sort_order: 20,
    enabled: true,
    is_builtin: true,
  },
  "selection.grammar": {
    id: "selection.grammar",
    kind: "quick_action",
    name: "Grammar",
    description: "Analyze the grammar of the selected text",
    prompt_template: "Analyze the grammar of the following text in {target_language}:\n\n{text}",
    requires_selection: true,
    show_in_quick_actions: true,
    icon: "grammar",
    sort_order: 30,
    enabled: true,
    is_builtin: true,
  },
};

const PROMPT_FEATURE_ICON_OPTIONS = ["sparkles", "translate", "explain", "grammar", "book-open"];

// Default preset models
const DEFAULT_MODELS = {
  openai: [
    { value: "gpt-4o", labelKey: "settings.models.openai.gpt-4o" },
    { value: "gpt-4o-mini", labelKey: "settings.models.openai.gpt-4o-mini" },
    { value: "gpt-4-turbo", labelKey: "settings.models.openai.gpt-4-turbo" },
    { value: "gpt-3.5-turbo", labelKey: "settings.models.openai.gpt-3.5-turbo" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-6", labelKey: "settings.models.anthropic.claude-sonnet-4-6" },
    { value: "claude-haiku-4-5", labelKey: "settings.models.anthropic.claude-haiku-4-5" },
    { value: "claude-opus-4-6", labelKey: "settings.models.anthropic.claude-opus-4-6" },
  ],
  openrouter: [
    { value: "openai/gpt-4o", labelKey: "settings.models.openrouter.openai/gpt-4o" },
    { value: "openai/gpt-4o-mini", labelKey: "settings.models.openrouter.openai/gpt-4o-mini" },
    { value: "anthropic/claude-3-haiku", labelKey: "settings.models.openrouter.anthropic/claude-3-haiku" },
    { value: "google/gemini-pro-1.5", labelKey: "settings.models.openrouter.google/gemini-pro-1.5" },
  ],
  deepseek: [
    { value: "deepseek-chat", labelKey: "settings.models.deepseek.deepseek-chat" },
    { value: "deepseek-coder", labelKey: "settings.models.deepseek.deepseek-coder" },
  ],
  siliconflow: [
    { value: "deepseek-ai/DeepSeek-V3", labelKey: "settings.models.siliconflow.deepseek-v3" },
    { value: "deepseek-ai/DeepSeek-R1", labelKey: "settings.models.siliconflow.deepseek-r1" },
  ],
  "302ai": [
    { value: "gpt-4o", labelKey: "settings.models.302ai.gpt-4o" },
    { value: "claude-3-5-sonnet-20241022", labelKey: "settings.models.302ai.claude-3-5-sonnet" },
  ],
  google: [
    { value: "gemini-2.0-flash-exp", labelKey: "settings.models.google.gemini-2.0-flash-exp" },
    { value: "gemini-1.5-pro", labelKey: "settings.models.google.gemini-1.5-pro" },
    { value: "gemini-1.5-flash", labelKey: "settings.models.google.gemini-1.5-flash" },
  ],
  "google-ai-studio": [
    { value: "gemini-2.0-flash-exp", labelKey: "settings.models.google-ai-studio.gemini-2.0-flash-exp" },
    { value: "models/gemini-3-flash-preview", labelKey: "settings.models.google-ai-studio.gemini-3-flash-preview" },
    { value: "models/gemini-3-pro-preview", labelKey: "settings.models.google-ai-studio.gemini-3-pro-preview" },
    { value: "gemini-1.5-pro", labelKey: "settings.models.google-ai-studio.gemini-1.5-pro" },
    { value: "gemini-1.5-flash", labelKey: "settings.models.google-ai-studio.gemini-1.5-flash" },
  ],
  [LEGACY_KIMI_PROVIDER]: [
    { value: "kimi-k2.5", labelKey: "settings.models.moonshot.kimi-k2.5" },
    { value: "moonshot-v1-128k", labelKey: "settings.models.moonshot.moonshot-v1-128k" },
    { value: "moonshot-v1-32k", labelKey: "settings.models.moonshot.moonshot-v1-32k" },
    { value: "moonshot-v1-8k", labelKey: "settings.models.moonshot.moonshot-v1-8k" },
  ],
  [KIMI_CHINA_PROVIDER]: [
    { value: "kimi-k2.5", labelKey: "settings.models.moonshot.kimi-k2.5" },
    { value: "moonshot-v1-128k", labelKey: "settings.models.moonshot.moonshot-v1-128k" },
    { value: "moonshot-v1-32k", labelKey: "settings.models.moonshot.moonshot-v1-32k" },
    { value: "moonshot-v1-8k", labelKey: "settings.models.moonshot.moonshot-v1-8k" },
  ],
  [KIMI_GLOBAL_PROVIDER]: [
    { value: "kimi-k2.5", labelKey: "settings.models.moonshot.kimi-k2.5" },
    { value: "moonshot-v1-128k", labelKey: "settings.models.moonshot.moonshot-v1-128k" },
    { value: "moonshot-v1-32k", labelKey: "settings.models.moonshot.moonshot-v1-32k" },
    { value: "moonshot-v1-8k", labelKey: "settings.models.moonshot.moonshot-v1-8k" },
  ],
  ollama: [
    { value: "qwen2.5:7b-instruct", labelKey: "settings.models.ollama.qwen2_5_7b_instruct" },
    { value: "llama3.1:8b-instruct", labelKey: "settings.models.ollama.llama3_1_8b_instruct" },
  ],
  // Providers that require custom model input
  "openai-compatible": [],
  "lmstudio": [],
};

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
}

type SettingsSectionId = "models" | "features" | "general" | "appearance" | "logs";

export function SettingsDialog({ isOpen, onClose, onSave }: SettingsDialogProps) {
  const { t, i18n } = useTranslation();
  const { themeName, themeMode, setThemeName, setThemeMode } = useTheme();
  const [config, setConfig] = useState<AppConfig>({
    model_configs: [],
    target_language: "zh-CN",
    interface_language: i18n.language,
    batch_translation_concurrency: 3,
    prompt_features: [],
  });

  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCorrupted, setIsCorrupted] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("models");

  // Model config form state
  const [editingConfig, setEditingConfig] = useState<Partial<ModelConfig> | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const [isSyncingModels, setIsSyncingModels] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [dynamicModels, setDynamicModels] = useState<Record<string, { value: string; label: string }[]>>({
    openai: DEFAULT_MODELS.openai.map(m => ({ value: m.value, label: t(m.labelKey) })),
    anthropic: DEFAULT_MODELS.anthropic.map(m => ({ value: m.value, label: t(m.labelKey) })),
    openrouter: DEFAULT_MODELS.openrouter.map(m => ({ value: m.value, label: t(m.labelKey) })),
    deepseek: DEFAULT_MODELS.deepseek.map(m => ({ value: m.value, label: t(m.labelKey) })),
    siliconflow: DEFAULT_MODELS.siliconflow.map(m => ({ value: m.value, label: t(m.labelKey) })),
    "302ai": DEFAULT_MODELS["302ai"].map(m => ({ value: m.value, label: t(m.labelKey) })),
    google: DEFAULT_MODELS.google.map(m => ({ value: m.value, label: t(m.labelKey) })),
    "google-ai-studio": DEFAULT_MODELS["google-ai-studio"].map(m => ({ value: m.value, label: t(m.labelKey) })),
    [LEGACY_KIMI_PROVIDER]: DEFAULT_MODELS[LEGACY_KIMI_PROVIDER].map(m => ({ value: m.value, label: t(m.labelKey) })),
    [KIMI_CHINA_PROVIDER]: DEFAULT_MODELS[KIMI_CHINA_PROVIDER].map(m => ({ value: m.value, label: t(m.labelKey) })),
    [KIMI_GLOBAL_PROVIDER]: DEFAULT_MODELS[KIMI_GLOBAL_PROVIDER].map(m => ({ value: m.value, label: t(m.labelKey) })),
    ollama: DEFAULT_MODELS.ollama.map(m => ({ value: m.value, label: t(m.labelKey) })),
  });
  const [modelFilter, setModelFilter] = useState("");
  const [editingPromptFeatureId, setEditingPromptFeatureId] = useState<string | null>(null);
  const [isPromptTemplateHelpOpen, setIsPromptTemplateHelpOpen] = useState(false);

  // Load config on mount
  useEffect(() => {
    if (isOpen) {
      loadConfig();
    }
  }, [isOpen]);

  // Lock background scroll and close on Escape while the full-screen panel is open
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, onClose]);

  const loadConfig = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<AppConfig | null>("get_config");
      if (result) {
        setConfig({
          ...result,
          batch_translation_concurrency: normalizeBatchTranslationConcurrency(result.batch_translation_concurrency),
        });
        // Restore interface language from config or use current
        const savedLang = result.interface_language || i18n.language;
        if (savedLang !== i18n.language) {
          await i18n.changeLanguage(savedLang);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes("FATAL_CONFIG_CORRUPTION")) {
        setIsCorrupted(true);
        setError(t("settings.errors.configCorrupted"));
      } else {
        setError(errorMsg);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetConfig = () => {
    // Clear the error and corruption state, then start fresh
    setIsCorrupted(false);
    setError(null);
    startNewConfig();
  };

  const promptFeatures = config.prompt_features ?? [];
  const editingPromptFeature = promptFeatures.find((item) => item.id === editingPromptFeatureId) ?? null;

  const updatePromptFeatures = (updater: (current: PromptFeature[]) => PromptFeature[]) => {
    setConfig((current) => ({
      ...current,
      prompt_features: updater(current.prompt_features ?? []),
    }));
  };

  const startNewPromptFeature = () => {
    const nextSortOrder =
      promptFeatures.reduce((max, item) => Math.max(max, item.sort_order || 0), 0) + 10;
    const newFeature: PromptFeature = {
      id: crypto.randomUUID(),
      kind: "quick_action",
      name: "",
      description: "",
      prompt_template: "{text}",
      requires_selection: true,
      show_in_quick_actions: true,
      icon: "sparkles",
      sort_order: nextSortOrder,
      enabled: true,
      is_builtin: false,
    };

    updatePromptFeatures((current) => [...current, newFeature]);
    setEditingPromptFeatureId(newFeature.id);
    setIsPromptTemplateHelpOpen(false);
  };

  const updatePromptFeature = (featureId: string, patch: Partial<PromptFeature>) => {
    updatePromptFeatures((current) =>
      current.map((item) => (item.id === featureId ? { ...item, ...patch } : item)),
    );
  };

  const resetPromptFeature = (featureId: string) => {
    const builtinDefault = BUILTIN_PROMPT_FEATURE_DEFAULTS[featureId];
    if (!builtinDefault) {
      return;
    }

    updatePromptFeatures((current) =>
      current.map((item) => (item.id === featureId ? { ...builtinDefault } : item)),
    );
    setEditingPromptFeatureId(featureId);
    setIsPromptTemplateHelpOpen(false);
  };

  const deletePromptFeature = (featureId: string) => {
    updatePromptFeatures((current) => current.filter((item) => item.id !== featureId));
    if (editingPromptFeatureId === featureId) {
      setEditingPromptFeatureId(null);
    }
    setIsPromptTemplateHelpOpen(false);
  };

  const startNewConfig = () => {
    setEditingConfig({
      id: crypto.randomUUID(),
      name: "",
      api_key: "",
      api_provider: "openai",
      model: "gpt-4o-mini",
      is_default: config.model_configs.length === 0,
    });
    setIsEditing(true);
    setUseCustomModel(false);
    setCustomModelInput("");
    setSyncError(null);
  };

  const startEditConfig = (modelConfig: ModelConfig) => {
    const normalizedProvider = normalizeKimiProvider(modelConfig.api_provider) || modelConfig.api_provider;
    const normalizedConfig = {
      ...modelConfig,
      api_provider: normalizedProvider,
    };

    setEditingConfig(normalizedConfig);
    setIsEditing(true);
    // Check if current model is a custom model
    const providerModels = dynamicModels[normalizedProvider];
    const isCustom = !providerModels?.some(m => m.value === modelConfig.model);
    setUseCustomModel(isCustom);
    if (isCustom) {
      setCustomModelInput(modelConfig.model);
    }
    setSyncError(null);
  };

  const cancelEdit = () => {
    setEditingConfig(null);
    setIsEditing(false);
    setUseCustomModel(false);
    setCustomModelInput("");
    setSyncError(null);
  };

  const saveConfig = async () => {
    if (!editingConfig) return;

    if (!editingConfig.name?.trim()) {
      setError(t("settings.errors.configNameRequired"));
      return;
    }
    // API key is optional for local providers (ollama, lmstudio)
    const isLocalProvider = ["ollama", "lmstudio"].includes(editingConfig.api_provider || "");
    if (!isLocalProvider && !editingConfig.api_key?.trim()) {
      setError(t("settings.errors.apiKeyRequired"));
      return;
    }
    if (!useCustomModel && !editingConfig.model) {
      setError(t("settings.errors.modelRequired"));
      return;
    }
    if (useCustomModel && !customModelInput.trim()) {
      setError(t("settings.errors.modelRequired"));
      return;
    }

    const modelToUse = useCustomModel ? customModelInput.trim() : editingConfig.model!;

    const configToSave: ModelConfig = {
      id: editingConfig.id || crypto.randomUUID(),
      name: editingConfig.name.trim(),
      api_key: (editingConfig.api_key || "").trim(),
      api_provider: editingConfig.api_provider || "openai",
      model: modelToUse,
      is_default: editingConfig.is_default || false,
      base_url: editingConfig.base_url?.trim() || undefined,
    };

    setIsSaving(true);
    setError(null);
    try {
      const saved = await invoke<ModelConfig>("save_model_config", { config: configToSave });

      // Update local state
      const existingIndex = config.model_configs.findIndex(c => c.id === saved.id);
      if (existingIndex >= 0) {
        const newConfigs = [...config.model_configs];
        newConfigs[existingIndex] = saved;
        setConfig({ ...config, model_configs: newConfigs });
      } else {
        setConfig({ ...config, model_configs: [...config.model_configs, saved] });
      }

      onSave?.();
      cancelEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteConfig = async (configId: string) => {
    if (config.model_configs.length <= 1) {
      setError(t("settings.errors.cannotDeleteLastConfig"));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await invoke("delete_model_config", { configId });
      setConfig({
        ...config,
        model_configs: config.model_configs.filter(c => c.id !== configId),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const setActiveConfig = async (configId: string) => {
    setIsSaving(true);
    setError(null);
    try {
      const active = await invoke<ModelConfig>("set_active_model_config", { configId });
      setConfig({ ...config, active_model_id: active.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  /* Removed unused handleProviderChange */

  const handleInterfaceLanguageChange = async (lng: string) => {
    setConfig({ ...config, interface_language: lng });
    await i18n.changeLanguage(lng);
  };

  const syncModels = async (isAuto = false) => {
    if (!editingConfig) return;

    const provider = editingConfig.api_provider;
    // Ensure provider is defined and valid
    if (!provider || !["openrouter", "openai", "openai-compatible", "deepseek", "siliconflow", "302ai", "google", "google-ai-studio", KIMI_CHINA_PROVIDER, KIMI_GLOBAL_PROVIDER, LEGACY_KIMI_PROVIDER, "ollama"].includes(provider)) {
      if (!isAuto) setSyncError(t("settings.syncErrors.providerNotSupported") || "Provider not supported for sync");
      return;
    }

    const requiresApiKey = !["ollama"].includes(provider);
    if (requiresApiKey && !editingConfig.api_key?.trim()) {
      if (!isAuto) setSyncError(t("settings.syncErrors.apiKeyRequired"));
      return;
    }

    setIsSyncingModels(true);
    setSyncError(null);
    try {
      let url = "";
      let headers: Record<string, string> = {};

      if (provider === "openrouter") {
        url = "https://openrouter.ai/api/v1/models";
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
      } else if (provider === "openai" || provider === "openai-compatible") {
        if (editingConfig.base_url) {
          const baseUrl = editingConfig.base_url.replace(/\/$/, "");
          url = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
        } else {
          url = "https://api.openai.com/v1/models";
        }
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
      } else if (provider === "deepseek") {
        url = "https://api.deepseek.com/models";
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
      } else if (provider === "siliconflow") {
        // Add sub_type=chat to filter if possible, otherwise list all.
        // Docs say querying by sub_type is supported? "You can use it to filter models individually without setting type."
        url = "https://api.siliconflow.cn/v1/models?sub_type=chat";
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
      } else if (provider === "302ai") {
        // 302.ai params from user: ?llm=1&include_custom_models=1
        url = "https://api.302.ai/v1/models?llm=1&include_custom_models=1";
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
        headers = {
          "Content-Type": "application/json",
        };
      } else if (isKimiProvider(provider)) {
        url = getKimiModelsUrl(provider) || "";
        headers = {
          "Authorization": `Bearer ${editingConfig.api_key}`,
          "Content-Type": "application/json",
        };
      } else if (provider === "ollama") {
        const configuredBase = editingConfig.base_url?.trim() || DEFAULT_BASE_URLS.ollama;
        const trimmedBase = configuredBase.replace(/\/$/, "");
        const host = trimmedBase.endsWith("/v1") ? trimmedBase.slice(0, -3) : trimmedBase;
        url = `${host}/api/tags`;
        headers = {
          "Content-Type": "application/json",
        };
      }

      const response = await fetch(url, { method: "GET", headers });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      let syncedModels: { value: string; label: string }[] = [];

      if (provider === "openrouter") {
        if (data.data && Array.isArray(data.data)) {
          syncedModels = data.data
            .filter((m: OpenRouterModel) => !m.id.includes(":free"))
            .slice(0, 100)
            .map((m: OpenRouterModel) => ({
              value: m.id,
              label: m.name || m.id,
            }));
        }
      } else if (provider === "openai" || provider === "openai-compatible") {
        if (data.data && Array.isArray(data.data)) {
          syncedModels = data.data
            .filter((m: any) => provider === "openai-compatible" || m.id.includes("gpt") || m.id.includes("o1"))
            .map((m: any) => ({
              value: m.id,
              label: m.id,
            }))
            .sort((a: { value: string }, b: { value: string }) => b.value.localeCompare(a.value));
        }
      } else if (provider === "deepseek") {
        if (data.data && Array.isArray(data.data)) {
          syncedModels = data.data
            .map((m: any) => ({
              value: m.id,
              label: m.id,
            }));
        }
      } else if (provider === "siliconflow") {
        if (data.data && Array.isArray(data.data)) {
          // SiliconFlow format: { data: [{ id: "...", ... }] }
          syncedModels = data.data
            .map((m: any) => ({
              value: m.id,
              label: m.id,
            }));
        }
      } else if (provider === "302ai") {
        if (data.data && Array.isArray(data.data)) {
          // 302.ai format: { data: [{ id: "...", ... }] }
          syncedModels = data.data
            .map((m: any) => ({
              value: m.id,
              label: m.id,
            }));
        }
      } else if (provider === "google") {
        // Google returns { models: [...] }
        if (data.models && Array.isArray(data.models)) {
          syncedModels = data.models
            .map((m: any) => ({
              value: m.name.replace("models/", ""),
              label: m.displayName || m.name.replace("models/", ""),
            }))
            .filter((m: { value: string }) => m.value.includes("gemini"));
        }
      } else if (isKimiProvider(provider)) {
        if (data.data && Array.isArray(data.data)) {
          syncedModels = data.data
            .map((m: any) => ({
              value: m.id,
              label: m.id,
            }));
        }
      } else if (provider === "ollama") {
        if (data.models && Array.isArray(data.models)) {
          syncedModels = data.models
            .map((m: any) => ({
              value: m.name,
              label: m.name,
            }));
        }
      }

      if (syncedModels.length > 0) {
        if (provider) {
          setDynamicModels((prev) => ({
            ...prev,
            [provider]: syncedModels,
          }));
        }

        // If current model is not in list (e.g. initial setup), potentially select first one?
        // Let's NOT auto-select to avoid overwriting user choice unless it's empty.
        if (!editingConfig.model && syncedModels.length > 0) {
          setEditingConfig(prev => ({ ...prev, model: syncedModels[0].value }));
        }
      }

    } catch (err) {
      if (!isAuto) {
        setSyncError(`${t("settings.syncErrors.syncFailed")}: ${err}`);
      }
      console.error("Model sync failed:", err);
    } finally {
      setIsSyncingModels(false);
    }
  };

  const availableModels = (editingConfig?.api_provider
    ? dynamicModels[editingConfig.api_provider] || []
    : []).filter(model => {
      if (!modelFilter) return true;
      try {
        const regex = new RegExp(modelFilter, "i");
        return regex.test(model.value) || regex.test(model.label);
      } catch (e) {
        // Fallback to simple includes if regex is invalid
        const lowerFilter = modelFilter.toLowerCase();
        return model.value.toLowerCase().includes(lowerFilter) ||
          model.label.toLowerCase().includes(lowerFilter);
      }
    });

  // Auto-sync when provider changes (if key exists)
  useEffect(() => {
    if (editingConfig?.api_provider && editingConfig?.api_key) {
      // Debounce or just run? React effects run after render, so state is updated.
      // We only want to run this when provider changes explicitly? 
      // Actually, handleProviderChange updates state. We can trigger it there, 
      // OR here. If here, need to be careful about infinite loops or running on every keystroke.
      // Better to just trigger in handleProviderChange and onBlur.
    }
  }, []); // Keep empty, we handle triggers manually to avoid excessive calls

  const handleDisplayProviderChange = (provider: string) => {
    const models = dynamicModels[provider];

    // Preserve API Key if switching between compatible providers? 
    // Usually NO, keys are provider specific.
    // However, we need to clear key if it's a new provider to avoid confusion?
    // Current logic preserves key in state but maybe it shouldn't.
    // The user asks for auto sync.

    // Check if we have a key for this provider stored previously? 
    // No, existing logic edits a config object. 

    setEditingConfig((prev) => {
      const newConfig = {
        ...prev,
        api_provider: provider,
        model: models?.[0]?.value || "",
        // For local providers, set default base URL
        base_url: DEFAULT_BASE_URLS[provider] || undefined,
      };

      return newConfig;
    });
    // For providers without preset models, enable custom model input
    const needsCustomModel = ["openai-compatible", "lmstudio"].includes(provider);
    setUseCustomModel(needsCustomModel);
  };

  const INTERFACE_LANGUAGES = [
    { value: "en", label: t("settings.interfaceLanguages.en") },
    { value: "zh", label: t("settings.interfaceLanguages.zh") },
    { value: "ja", label: t("settings.interfaceLanguages.ja") },
  ];

  const TARGET_LANGUAGES = [
    { value: "en", label: t("settings.languages.en") },
    { value: "zh-CN", label: t("settings.languages.zh-CN") },
    { value: "zh-TW", label: t("settings.languages.zh-TW") },
    { value: "ja", label: t("settings.languages.ja") },
    { value: "ko", label: t("settings.languages.ko") },
    { value: "es", label: t("settings.languages.es") },
    { value: "fr", label: t("settings.languages.fr") },
    { value: "de", label: t("settings.languages.de") },
    { value: "ru", label: t("settings.languages.ru") },
    { value: "ar", label: t("settings.languages.ar") },
  ];

  const saveAndClose = async () => {
    // Save backend config before closing
    setIsSaving(true);
    try {
      await invoke("save_config_cmd", { config });
      onSave?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
    onClose();
  };

  const SECTIONS: { id: SettingsSectionId; label: string; icon: typeof Cpu }[] = [
    { id: "models", label: t("settings.sections.models", "Model Providers"), icon: Cpu },
    { id: "features", label: t("settings.sections.features", "Chat Features"), icon: MessageSquare },
    { id: "general", label: t("settings.sections.general", "General"), icon: SlidersHorizontal },
    { id: "appearance", label: t("settings.sections.appearance", "Appearance"), icon: Palette },
    { id: "logs", label: t("settings.sections.logs", "Logs"), icon: ScrollText },
  ];

  if (!isOpen) return null;

  const errorBanner = error && (
    <div className="mb-6 p-3 bg-destructive/10 border border-destructive/50 rounded-lg text-destructive text-sm flex flex-col gap-2">
      <div>{error}</div>
      {isCorrupted && (
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={handleResetConfig}
          className="w-fit"
        >
          {t("settings.resetConfig")}
        </Button>
      )}
    </div>
  );

  const modelsSection = (
    <div className="space-y-6">
          {/* Model Configurations Section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-medium text-foreground">
                  {t("settings.modelConfigs")}
                </h3>
                <button
                  type="button"
                  // 点击后在浏览器打开文档链接
                  onClick={() => openUrl("https://www.openkoto.com/")}
                  className="text-muted-foreground hover:text-primary transition-colors focus:outline-none"
                  title={t("settings.syncErrors.modelHelpTooltip")}
                >
                  <HelpCircle size={16} />
                </button>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={startNewConfig}
                disabled={isEditing}
                className="gap-1"
              >
                <Plus size={14} />
                {t("settings.addConfig")}
              </Button>
            </div>

            {/* Config List */}
            <div className="space-y-2 mb-4">
              {config.model_configs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground border border-dashed border-border rounded-lg">
                  {t("settings.noConfigs")}
                </div>
              ) : (
                config.model_configs.map((modelConfig) => (
                  <div
                    key={modelConfig.id}
                    className={`p-3 rounded-lg border flex items-center justify-between gap-3 ${config.active_model_id === modelConfig.id
                      ? "bg-primary/10 border-primary"
                      : "bg-card border-border"
                      }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground truncate">
                          {modelConfig.name}
                        </span>
                        {config.active_model_id === modelConfig.id && (
                          <span className="text-xs px-1.5 py-0.5 bg-primary text-primary-foreground rounded">
                            {t("settings.active")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {t(`settings.providers.${modelConfig.api_provider}`)} / {modelConfig.model}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {config.active_model_id !== modelConfig.id && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setActiveConfig(modelConfig.id)}
                          disabled={isSaving}
                          title={t("settings.setAsActive")}
                          className="h-7 w-7 p-0"
                        >
                          <Check size={14} />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditConfig(modelConfig)}
                        disabled={isEditing || isSaving}
                        title={t("settings.editConfig")}
                        className="h-7 w-7 p-0"
                      >
                        <Edit2 size={14} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteConfig(modelConfig.id)}
                        disabled={isEditing || isSaving}
                        title={t("settings.deleteConfig")}
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive/80"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Edit Form */}
            {isEditing && editingConfig && (
              <div className="p-4 bg-muted/50 rounded-lg border border-border space-y-4">
                <h4 className="font-medium text-foreground">
                  {editingConfig.id && config.model_configs.some(c => c.id === editingConfig.id)
                    ? t("settings.editConfig")
                    : t("settings.newConfig")}
                </h4>

                {/* Config Name */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    {t("settings.configName")}
                  </label>
                  <Input
                    type="text"
                    value={editingConfig.name || ""}
                    onChange={(e) => setEditingConfig({ ...editingConfig, name: e.target.value })}
                    placeholder={t("settings.configNamePlaceholder")}
                  />
                </div>

                {/* Provider */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    {t("settings.apiProvider")}
                  </label>
                  <Select
                    value={editingConfig.api_provider || "openai"}
                    onChange={(e) => handleDisplayProviderChange(e.target.value)}
                  >
                    {SUPPORTED_PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {t(`settings.providers.${provider}`)}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* Base URL - show for openai-compatible, ollama, lmstudio */}
                {["openai-compatible", "ollama", "lmstudio"].includes(editingConfig.api_provider || "") && (
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      {t("settings.baseUrl")}
                    </label>
                    <Input
                      type="text"
                      value={editingConfig.base_url || ""}
                      onChange={(e) => setEditingConfig({ ...editingConfig, base_url: e.target.value })}
                      placeholder={t("settings.baseUrlPlaceholder")}
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("settings.baseUrlHelp")}
                    </p>
                    {editingConfig.api_provider === "openai-compatible" && editingConfig.base_url &&
                      (editingConfig.base_url.includes("/chat/completions") || !editingConfig.base_url.endsWith("/v1")) && (
                        <p className="text-xs text-yellow-500/80 mt-1 italic">
                          {t("settings.baseUrlTip")}
                        </p>
                      )}
                  </div>
                )}

                {/* API Key */}
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">
                    {["ollama", "lmstudio"].includes(editingConfig.api_provider || "")
                      ? t("settings.apiKeyOptional")
                      : t("settings.apiKey")}
                  </label>
                  <Input
                    type="password"
                    value={editingConfig.api_key || ""}
                    onChange={(e) => setEditingConfig({ ...editingConfig, api_key: e.target.value })}
                    onBlur={() => syncModels(true)}
                    placeholder={t("settings.apiKeyPlaceholder")}
                  />
                </div>

                {/* Model */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-foreground">
                      {t("settings.model")}
                    </label>
                    {(["openrouter", "openai", "deepseek", "google", "google-ai-studio", "302ai", "siliconflow", "ollama"].includes(editingConfig.api_provider || "") || isKimiProvider(editingConfig.api_provider || "")) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => syncModels(false)}
                        disabled={isSyncingModels || (editingConfig.api_provider !== "ollama" && !editingConfig.api_key)}
                        className="h-6 px-2 text-xs"
                        title={t("settings.syncModelsTooltip")}
                      >
                        <RefreshCw size={12} className={isSyncingModels ? "animate-spin" : ""} />
                        {isSyncingModels ? t("settings.syncing") : t("settings.syncModels")}
                      </Button>
                    )}
                  </div>
                  {!useCustomModel && (
                    <div className="mb-2">
                      <Input
                        type="text"
                        value={modelFilter}
                        onChange={(e) => setModelFilter(e.target.value)}
                        placeholder={t("settings.modelFilterPlaceholder")}
                        className="h-8 text-xs"
                      />
                    </div>
                  )}
                  {!useCustomModel ? (
                    <Select
                      value={editingConfig.model || ""}
                      onChange={(e) => {
                        if (e.target.value === "__custom__") {
                          setUseCustomModel(true);
                        } else {
                          setEditingConfig({ ...editingConfig, model: e.target.value });
                        }
                      }}
                    >
                      {availableModels.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.label}
                        </option>
                      ))}
                      <option value="__custom__">{t("settings.customModel")}</option>
                    </Select>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        type="text"
                        value={customModelInput}
                        onChange={(e) => setCustomModelInput(e.target.value)}
                        placeholder={t("settings.customModelPlaceholder")}
                        className="w-full"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setUseCustomModel(false)}
                        className="h-6 px-2 text-xs"
                      >
                        {t("settings.usePresetModel")}
                      </Button>
                    </div>
                  )}
                  {syncError && (
                    <div className="mt-2 text-xs text-yellow-400">
                      {syncError}
                    </div>
                  )}
                </div>

                {/* Form Actions */}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={cancelEdit}
                    disabled={isSaving}
                  >
                    {t("settings.cancel")}
                  </Button>
                  <Button
                    type="button"
                    onClick={saveConfig}
                    disabled={isSaving}
                  >
                    {isSaving ? (
                      <>
                        <Loader2 size={14} className="animate-spin mr-1" />
                        {t("settings.saving")}
                      </>
                    ) : (
                      t("settings.saveConfig")
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
    </div>
  );

  const featuresSection = (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-foreground">
                {t("settings.promptFeatures.title", "AI Chat Features")}
              </h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={startNewPromptFeature}
                className="gap-1"
              >
                <Plus size={14} />
                {t("settings.promptFeatures.add", "Add feature")}
              </Button>
            </div>

            <div className="space-y-2">
              {promptFeatures.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground border border-dashed border-border rounded-lg">
                  {t("settings.promptFeatures.empty", "No chat features configured")}
                </div>
              ) : (
                promptFeatures
                  .slice()
                  .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name))
                  .map((feature) => (
                    <div
                      key={feature.id}
                      className={`p-3 rounded-lg border flex items-center justify-between gap-3 ${editingPromptFeatureId === feature.id
                        ? "bg-primary/5 border-primary"
                        : "bg-card border-border"
                        }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground truncate">
                            {feature.name || t("settings.promptFeatures.untitled", "Untitled feature")}
                          </span>
                          {feature.is_builtin && (
                            <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                              {t("settings.promptFeatures.builtin", "Built-in")}
                            </span>
                          )}
                          {!feature.enabled && (
                            <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                              {t("settings.promptFeatures.disabled", "Disabled")}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {feature.kind === "chat_default"
                            ? t("settings.promptFeatures.chatDefault", "Default chat prompt")
                            : t("settings.promptFeatures.quickAction", "Quick action")}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingPromptFeatureId(feature.id)}
                          className="h-7 w-7 p-0"
                          title={t("settings.editConfig", "Edit")}
                        >
                          <Edit2 size={14} />
                        </Button>
                        {feature.is_builtin ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => resetPromptFeature(feature.id)}
                            className="h-7 px-2 text-xs"
                          >
                            {t("settings.promptFeatures.resetBuiltin", "Reset to default")}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => deletePromptFeature(feature.id)}
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive/80"
                            title={t("settings.promptFeatures.deleteCustom", "Delete feature")}
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>

            {editingPromptFeature && (
              <div className="p-4 bg-muted/50 rounded-lg border border-border space-y-4">
                <h4 className="font-medium text-foreground">
                  {editingPromptFeature.is_builtin
                    ? t("settings.promptFeatures.editBuiltin", "Edit built-in feature")
                    : t("settings.promptFeatures.editCustom", "Edit custom feature")}
                </h4>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-2" htmlFor="prompt-feature-name">
                    {t("settings.promptFeatures.name", "Feature name")}
                  </label>
                  <Input
                    id="prompt-feature-name"
                    aria-label={t("settings.promptFeatures.name", "Feature name")}
                    type="text"
                    value={editingPromptFeature.name}
                    onChange={(e) => updatePromptFeature(editingPromptFeature.id, { name: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-2" htmlFor="prompt-feature-description">
                    {t("settings.promptFeatures.description", "Description")}
                  </label>
                  <Input
                    id="prompt-feature-description"
                    aria-label={t("settings.promptFeatures.description", "Description")}
                    type="text"
                    value={editingPromptFeature.description}
                    onChange={(e) => updatePromptFeature(editingPromptFeature.id, { description: e.target.value })}
                  />
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="block text-sm font-medium text-foreground" htmlFor="prompt-feature-template">
                      {t("settings.promptFeatures.template", "Prompt template")}
                    </label>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-primary transition-colors focus:outline-none"
                      aria-label={t("settings.promptFeatures.templateHelpAriaLabel", "What is {text}?")}
                      onClick={() => setIsPromptTemplateHelpOpen((current) => !current)}
                    >
                      <HelpCircle size={14} />
                    </button>
                  </div>
                  {isPromptTemplateHelpOpen && (
                    <p className="mb-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                      {t(
                        "settings.promptFeatures.templateHelp",
                        "{text} will be replaced with the selected text when this feature runs.",
                      )}
                    </p>
                  )}
                  <textarea
                    id="prompt-feature-template"
                    aria-label={t("settings.promptFeatures.template", "Prompt template")}
                    value={editingPromptFeature.prompt_template}
                    onChange={(e) => updatePromptFeature(editingPromptFeature.id, { prompt_template: e.target.value })}
                    className="flex min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-2" htmlFor="prompt-feature-icon">
                    {t("settings.promptFeatures.icon", "Icon")}
                  </label>
                  <Select
                    value={editingPromptFeature.icon}
                    onChange={(e) => updatePromptFeature(editingPromptFeature.id, { icon: e.target.value })}
                    id="prompt-feature-icon"
                    aria-label={t("settings.promptFeatures.icon", "Icon")}
                  >
                    {PROMPT_FEATURE_ICON_OPTIONS.map((icon) => (
                      <option key={icon} value={icon}>
                        {icon}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-2" htmlFor="prompt-feature-sort-order">
                    {t("settings.promptFeatures.sortOrder", "Sort order")}
                  </label>
                  <Input
                    id="prompt-feature-sort-order"
                    aria-label={t("settings.promptFeatures.sortOrder", "Sort order")}
                    type="number"
                    value={editingPromptFeature.sort_order}
                    onChange={(e) =>
                      updatePromptFeature(editingPromptFeature.id, {
                        sort_order: Number.parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={editingPromptFeature.enabled}
                    onChange={(e) => updatePromptFeature(editingPromptFeature.id, { enabled: e.target.checked })}
                  />
                  {t("settings.promptFeatures.enabled", "Enabled")}
                </label>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={editingPromptFeature.requires_selection}
                    onChange={(e) =>
                      updatePromptFeature(editingPromptFeature.id, { requires_selection: e.target.checked })
                    }
                    disabled={editingPromptFeature.kind === "chat_default"}
                  />
                  {t("settings.promptFeatures.requiresSelection", "Requires selection")}
                </label>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={editingPromptFeature.show_in_quick_actions}
                    onChange={(e) =>
                      updatePromptFeature(editingPromptFeature.id, {
                        show_in_quick_actions: e.target.checked,
                      })
                    }
                    disabled={editingPromptFeature.kind === "chat_default"}
                  />
                  {t("settings.promptFeatures.showInQuickActions", "Show in quick actions")}
                </label>
              </div>
            )}
          </div>
  );

  const appearanceSection = (
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-foreground">
              {t("settings.sections.appearance", "Appearance")}
            </h3>

            {/* Theme Name */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t("settings.theme.themeName")}
              </label>
              <Select
                value={themeName}
                onChange={(e) => setThemeName(e.target.value as any)}
              >
                <option value="seoul">{t("settings.theme.seoul")}</option>
                <option value="tokyo">{t("settings.theme.tokyo")}</option>
                <option value="california">{t("settings.theme.california")}</option>
              </Select>
            </div>

            {/* Theme Mode */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t("settings.theme.themeMode")}
              </label>
              <Select
                value={themeMode}
                onChange={(e) => setThemeMode(e.target.value as any)}
              >
                <option value="light">{t("settings.theme.light")}</option>
                <option value="dark">{t("settings.theme.dark")}</option>
                <option value="system">{t("settings.theme.system")}</option>
              </Select>
            </div>
          </div>
  );

  const generalSection = (
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-foreground">
              {t("settings.sections.general", "General")}
            </h3>

            {/* Interface Language */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t("settings.interfaceLanguage")}
              </label>
              <Select
                value={config.interface_language}
                onChange={(e) => handleInterfaceLanguageChange(e.target.value)}
              >
                {INTERFACE_LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </Select>
            </div>

            {/* Target Language */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t("settings.targetLanguage")}
              </label>
              <Select
                value={config.target_language}
                onChange={(e) => setConfig({ ...config, target_language: e.target.value })}
              >
                {TARGET_LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </Select>
            </div>

            {/* Batch Explanation Concurrency */}
            <div>
              <label
                htmlFor="batch-translation-concurrency"
                className="block text-sm font-medium text-foreground mb-2"
              >
                {t("settings.batchTranslationConcurrency", "Batch explanation concurrency")}
              </label>
              <Input
                id="batch-translation-concurrency"
                type="number"
                min={MIN_BATCH_TRANSLATION_CONCURRENCY}
                max={MAX_BATCH_TRANSLATION_CONCURRENCY}
                step={1}
                value={config.batch_translation_concurrency ?? DEFAULT_BATCH_TRANSLATION_CONCURRENCY}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    batch_translation_concurrency: normalizeBatchTranslationConcurrency(e.target.value),
                  })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t(
                  "settings.batchTranslationConcurrencyHelp",
                  "Controls how many segments are explained at the same time. Higher values are faster but may hit model rate limits.",
                )}
              </p>
            </div>
          </div>
  );

  const sectionContent: Record<SettingsSectionId, ReactNode> = {
    models: modelsSection,
    features: featuresSection,
    general: generalSection,
    appearance: appearanceSection,
    logs: <LogsPanel />,
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/50">
        <div className="flex items-center gap-2 px-5 py-5 border-b border-border">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Settings size={18} />
          </div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.title")}</h2>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <ul className="space-y-1">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setActiveSection(id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    activeSection === id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                  aria-current={activeSection === id ? "page" : undefined}
                >
                  <Icon size={16} />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-border p-3">
          <Button
            variant="secondary"
            className="w-full"
            onClick={saveAndClose}
            disabled={isSaving}
          >
            {isSaving ? t("settings.saving", "Saving...") : t("settings.close", "Close")}
          </Button>
        </div>
      </aside>

      {/* Content */}
      <div className="relative flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={saveAndClose}
          disabled={isSaving}
          className="absolute right-4 top-4 z-10 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          aria-label={t("settings.close", "Close")}
        >
          <X size={20} />
        </button>

        <div
          className={`mx-auto px-8 py-8 ${activeSection === "logs" ? "h-full max-w-5xl flex flex-col" : "max-w-2xl"}`}
        >
          {errorBanner}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            </div>
          ) : (
            sectionContent[activeSection]
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface SettingsButtonProps {
  onOpen?: () => void;
  onSave?: () => void;
}

export function SettingsButton({ onOpen, onSave }: SettingsButtonProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const handleOpen = () => {
    onOpen?.();
    setIsOpen(true);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleOpen}
        className="gap-2 text-foreground"
      >
        <Settings size={16} />
        {t("header.settings")}
      </Button>
      <SettingsDialog
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSave={onSave}
      />
    </>
  );
}
