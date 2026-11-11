export const UBERLLM_PROVIDER = "uberllm";

export function isUberllmProvider(provider: string): boolean {
  return provider === UBERLLM_PROVIDER;
}

export function getUberllmBaseUrl(provider: string): string | null {
  return isUberllmProvider(provider) ? "https://api.uberllm.dev/v1" : null;
}

export function getUberllmModelsUrl(provider: string): string | null {
  const baseUrl = getUberllmBaseUrl(provider);
  return baseUrl ? `${baseUrl}/models` : null;
}
