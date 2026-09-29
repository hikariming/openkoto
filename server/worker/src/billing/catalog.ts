import type { Plan } from "@openkoto/core";

/** Credits included with each Pro billing period. */
export const PRO_MONTHLY_CREDITS = 1500;

export interface Sku {
  id: string;
  kind: "subscription" | "credits";
  plan?: Plan;
  /** Length of one billing period. */
  durationDays?: number;
  credits?: number;
  priceCny: number;
  /** Creem only charges in USD/EUR/SEK; this is the web price. */
  priceUsd?: number;
  /** Which storefronts sell it. Creem has a $0.40 fixed fee, so no cheap monthly plans there. */
  channels: ("creem" | "appstore")[];
}

// Prices decided 2026-09-28 (docs/plans/2026-09-28-web-and-cloud-platform-design.md §11).
export const SKUS: Sku[] = [
  { id: "plus_month", kind: "subscription", plan: "plus", durationDays: 31, priceCny: 8, channels: ["appstore"] },
  { id: "plus_year", kind: "subscription", plan: "plus", durationDays: 366, priceCny: 68, priceUsd: 9.49, channels: ["creem", "appstore"] },
  { id: "pro_month", kind: "subscription", plan: "pro", durationDays: 31, credits: PRO_MONTHLY_CREDITS, priceCny: 28, priceUsd: 3.89, channels: ["creem", "appstore"] },
  { id: "pro_year", kind: "subscription", plan: "pro", durationDays: 366, credits: PRO_MONTHLY_CREDITS * 12, priceCny: 258, priceUsd: 35.99, channels: ["creem", "appstore"] },
  { id: "credits_3000", kind: "credits", credits: 3000, priceCny: 28, priceUsd: 4.19, channels: ["creem", "appstore"] },
];

export function skuById(id: string): Sku | undefined {
  return SKUS.find((s) => s.id === id);
}

/** Maps a storefront product id to a SKU via a JSON env var: { "<productId>": "<skuId>" }. */
export function skuForProduct(mappingJson: string | undefined, productId: string): Sku | undefined {
  if (!mappingJson) return undefined;
  const mapping = JSON.parse(mappingJson) as Record<string, string | { sku?: string }>;
  const entry = mapping[productId];
  const skuId = typeof entry === "string" ? entry : entry?.sku;
  return skuId ? skuById(skuId) : undefined;
}

export function productForSku(mappingJson: string | undefined, skuId: string): string | undefined {
  if (!mappingJson) return undefined;
  const mapping = JSON.parse(mappingJson) as Record<string, string | { sku?: string }>;
  return Object.entries(mapping).find(([, v]) => (typeof v === "string" ? v : v?.sku) === skuId)?.[0];
}
