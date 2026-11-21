import {
  localDateString,
  normalizeWord,
  reviewCard,
  SCHEDULER_VERSION,
  type FavoriteVocabulary,
  type Grade,
  type JsonObject,
  type WordPack,
} from "@openkoto/core";
import type { LocalChange } from "@openkoto/client";
import type { RecordType } from "@openkoto/core";
import type { IndexedDbStore } from "./store";

type Write = (type: RecordType, id: string, change: LocalChange) => Promise<void>;

export { normalizeWord } from "@openkoto/core";

export interface VocabDraft {
  word: string;
  meaning: string;
  reading?: string;
  example?: string;
  usage?: string;
  explanation?: string;
  sourceArticleId?: string;
  sourceArticleTitle?: string;
  sourceSegmentId?: string;
}

export function newVocabulary(draft: VocabDraft, now = new Date()): FavoriteVocabulary {
  const iso = now.toISOString();
  return {
    id: crypto.randomUUID(),
    word: draft.word.trim(),
    meaning: draft.meaning.trim(),
    reading: draft.reading?.trim() || null,
    example: draft.example?.trim() || null,
    usage: draft.usage?.trim() || null,
    explanation: draft.explanation?.trim() || null,
    sourceArticleId: draft.sourceArticleId ?? null,
    sourceArticleTitle: draft.sourceArticleTitle ?? null,
    sourceSegmentId: draft.sourceSegmentId ?? null,
    packIds: [],
    srsState: "new",
    stability: 0,
    difficulty: 0,
    schedulerVersion: SCHEDULER_VERSION,
    suspendedAt: null,
    dueDate: localDateString(now),
    lastReviewedAt: null,
    reviewCount: 0,
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Adds a word, or fills empty fields of an existing card with the same normalized word
 * (desktop's global de-duplication rule).
 */
export async function addVocabulary(store: IndexedDbStore, write: Write, draft: VocabDraft): Promise<FavoriteVocabulary> {
  return store.transaction(async () => {
    const existing = (await store.live("Vocabulary")).map((r) => r.payload as unknown as FavoriteVocabulary);
    const key = normalizeWord(draft.word);
    const dup = existing.find((v) => normalizeWord(v.word) === key);
    if (dup) {
      const merged: FavoriteVocabulary = { ...dup, updatedAt: new Date().toISOString() };
      for (const field of ["meaning", "reading", "example", "usage", "explanation"] as const) {
        const incoming = draft[field]?.trim();
        if (!merged[field] && incoming) merged[field] = incoming;
      }
      await write("Vocabulary", dup.id, { payload: merged as unknown as JsonObject });
      return merged;
    }
    const card = newVocabulary(draft);
    await write("Vocabulary", card.id, { payload: card as unknown as JsonObject });
    return card;
  });
}

export async function updateVocabulary(write: Write, card: FavoriteVocabulary, patch: Partial<VocabDraft>): Promise<void> {
  const next = { ...card, ...patch, updatedAt: new Date().toISOString() };
  await write("Vocabulary", card.id, { payload: next as unknown as JsonObject });
}

export async function deleteVocabulary(write: Write, card: FavoriteVocabulary): Promise<void> {
  await write("Vocabulary", card.id, { deleted: true });
  for (const packId of card.packIds ?? []) await write("WordPackMembership", `${card.id}_${packId}`, { deleted: true });
}

export async function setSuspended(write: Write, card: FavoriteVocabulary, suspended: boolean): Promise<void> {
  const now = new Date().toISOString();
  await write("Vocabulary", card.id, { payload: { ...card, suspendedAt: suspended ? now : null, updatedAt: now } as unknown as JsonObject });
}

export interface GradeResult {
  card: FavoriteVocabulary;
  event: JsonObject;
}

/** Grades a card: appends an immutable ReviewEvent and stores the new SRS state. */
export async function gradeCard(write: Write, card: FavoriteVocabulary, grade: Grade, desiredRetention?: number): Promise<GradeResult> {
  const now = new Date();
  const { card: next, event } = reviewCard(card, grade, now, { desiredRetention });
  const eventId = crypto.randomUUID();
  const payload = { id: eventId, ...event } as unknown as JsonObject;
  await write("ReviewEvent", eventId, { payload });
  const updated = { ...next, updatedAt: now.toISOString() };
  await write("Vocabulary", card.id, { payload: updated as unknown as JsonObject });
  return { card: updated, event: payload };
}

/**
 * Undoes a review (sync spec §6): appends a void event pointing at it and restores the card.
 * Every device skips voided events on replay, so the undo survives sync.
 */
export async function undoReview(write: Write, before: FavoriteVocabulary, event: JsonObject): Promise<void> {
  const voidId = crypto.randomUUID();
  await write("ReviewEvent", voidId, {
    payload: { ...event, id: voidId, grade: 0, voidsEventId: event.id as string, reviewedAt: new Date().toISOString() },
  });
  await write("Vocabulary", before.id, { payload: { ...before, updatedAt: new Date().toISOString() } as unknown as JsonObject });
}

// ---- word packs -------------------------------------------------------------

export function newPack(name: string, now = new Date()): WordPack {
  const iso = now.toISOString();
  return { id: crypto.randomUUID(), name: name.trim(), tags: [], isSystem: false, createdAt: iso, updatedAt: iso } as WordPack;
}

export async function setMembership(write: Write, card: FavoriteVocabulary, packId: string, member: boolean): Promise<void> {
  const packIds = new Set(card.packIds ?? []);
  if (member) packIds.add(packId);
  else packIds.delete(packId);
  const id = `${card.id}_${packId}`;
  if (member) await write("WordPackMembership", id, { payload: { vocabularyId: card.id, packId } });
  else await write("WordPackMembership", id, { deleted: true });
  await write("Vocabulary", card.id, { payload: { ...card, packIds: [...packIds], updatedAt: new Date().toISOString() } as unknown as JsonObject });
}

// ---- import / export ------------------------------------------------------

/** Parses CSV/TSV lines: word, meaning[, reading][, example]. */
export function parseWordList(text: string): VocabDraft[] {
  const drafts: VocabDraft[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim().replace(/^"|"$/g, ""));
    const [word, meaning = "", reading, example] = cells;
    if (word) drafts.push({ word, meaning, reading, example });
  }
  return drafts;
}
