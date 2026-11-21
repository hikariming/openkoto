import type { VocabularyItem } from "./models";

export function normalizeWord(word: string): string {
  return word.normalize("NFKC").trim().toLowerCase();
}

export function dedupeVocabulary(items: VocabularyItem[]): VocabularyItem[] {
  const words = new Map<string, VocabularyItem>();
  for (const item of items) {
    const key = normalizeWord(item.word);
    const existing = words.get(key);
    if (!existing) {
      words.set(key, { ...item });
      continue;
    }
    for (const field of ["meaning", "reading", "usage", "example"] as const) {
      if (!existing[field]?.trim() && item[field]?.trim()) existing[field] = item[field];
    }
  }
  return [...words.values()];
}
