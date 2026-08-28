export const META_PROVIDER = "meta";

export function isMetaProvider(provider: string): boolean {
  return provider === META_PROVIDER;
}

export function getMetaBaseUrl(provider: string): string | null {
  return isMetaProvider(provider) ? "https://api.meta.ai/v1" : null;
}

export function getMetaModelsUrl(provider: string): string | null {
  const baseUrl = getMetaBaseUrl(provider);
  return baseUrl ? `${baseUrl}/models` : null;
}
