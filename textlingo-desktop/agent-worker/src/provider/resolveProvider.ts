export interface RuntimeModelConfig {
  id: string;
  name: string;
  api_provider: string;
  api_key: string;
  model: string;
  is_default: boolean;
  base_url?: string;
}

export type ResolvedRuntimeProvider =
  | {
      kind: "openai_compatible";
      provider: string;
      model: string;
      api_key?: string;
      baseUrl: string;
    }
  | {
      kind: "native_google";
      provider: string;
      model: string;
      api_key: string;
    }
  | {
      kind: "native_anthropic";
      provider: string;
      model: string;
      api_key: string;
    }
  | {
      kind: "unsupported";
      provider: string;
      reason: string;
    };

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
const PROVIDER_302AI_BASE_URL = "https://api.302.ai/v1";
const META_BASE_URL = "https://api.meta.ai/v1";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
const LEGACY_KIMI_PROVIDER = "moonshot";
const KIMI_CHINA_PROVIDER = "moonshot-cn";
const KIMI_GLOBAL_PROVIDER = "moonshot-global";
const META_PROVIDER = "meta";

function isKimiProvider(provider: string) {
  return (
    provider === LEGACY_KIMI_PROVIDER ||
    provider === KIMI_CHINA_PROVIDER ||
    provider === KIMI_GLOBAL_PROVIDER
  );
}

function resolveDefaultBaseUrl(provider: string) {
  switch (provider) {
    case "openai":
      return OPENAI_BASE_URL;
    case "deepseek":
      return DEEPSEEK_BASE_URL;
    case "siliconflow":
      return SILICONFLOW_BASE_URL;
    case "302ai":
      return PROVIDER_302AI_BASE_URL;
    case "openrouter":
      return OPENROUTER_BASE_URL;
    case "ollama":
      return OLLAMA_BASE_URL;
    case "lmstudio":
      return LMSTUDIO_BASE_URL;
    case LEGACY_KIMI_PROVIDER:
    case KIMI_CHINA_PROVIDER:
      return "https://api.moonshot.cn/v1";
    case KIMI_GLOBAL_PROVIDER:
      return "https://api.moonshot.ai/v1";
    case META_PROVIDER:
    case "meta":
      return META_BASE_URL;
    default:
      return undefined;
  }
}

export function resolveRuntimeProvider(config: RuntimeModelConfig): ResolvedRuntimeProvider {
  const provider = config.api_provider;
  const baseUrl = config.base_url?.trim() || resolveDefaultBaseUrl(provider);

  if (provider === "google" || provider === "google-ai-studio") {
    return {
      kind: "native_google",
      provider,
      model: config.model,
      api_key: config.api_key,
    };
  }

  if (provider === "anthropic") {
    return {
      kind: "native_anthropic",
      provider,
      model: config.model,
      api_key: config.api_key,
    };
  }

  if (
    ([
      "openai",
      "openai-compatible",
      "openrouter",
      "deepseek",
      "siliconflow",
      "302ai",
      "ollama",
      "lmstudio",
      "meta",
    ].includes(provider) ||
      isKimiProvider(provider)) &&
    baseUrl
  ) {
    return {
      kind: "openai_compatible",
      provider,
      model: config.model,
      api_key: config.api_key,
      baseUrl,
    };
  }

  return {
    kind: "unsupported",
    provider,
    reason: `Provider ${provider} is not supported for the agent runtime`,
  };
}
