export const MARTLLM_PROVIDER = "martllm";

export function isMartllmProvider(provider: string): boolean {
  return provider === MARTLLM_PROVIDER;
}

export function getMartllmBaseUrl(provider: string): string | null {
  return isMartllmProvider(provider) ? "https://api.martllm.com/v1" : null;
}

export function getMartllmModelsUrl(provider: string): string | null {
  const baseUrl = getMartllmBaseUrl(provider);
  return baseUrl ? `${baseUrl}/models` : null;
}
