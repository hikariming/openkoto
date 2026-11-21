import { segmentText, type ArticleSegment, type RecordType } from "@openkoto/core";
import type { LocalChange } from "@openkoto/client";
import type { IndexedDbStore } from "./store";

type Write = (type: RecordType, id: string, change: LocalChange) => Promise<void>;

export async function segmentId(articleId: string, order: number): Promise<string> {
  const input = new TextEncoder().encode(`openkoto.segment.v1:${articleId.toLowerCase()}:${order}`);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureSegments(store: IndexedDbStore, write: Write, articleId: string, content: string): Promise<void> {
  const drafts = segmentText(content);
  const ids = await Promise.all(drafts.map((_, order) => segmentId(articleId, order)));
  await store.transaction(async () => {
    const article = await store.getRecord("Article", articleId);
    if (!article || article.deleted || article.payload?.content !== content) return;
    if ((await store.children("Segment", articleId)).length) return;
    const now = new Date().toISOString();
    for (const [order, draft] of drafts.entries()) {
      const id = ids[order]!;
      await write("Segment", id, { payload: { id, articleId, order, ...draft, segmentationRevision: 0, createdAt: now } });
    }
    const chapter = await store.getRecord("BookChapter", articleId);
    if (chapter && !chapter.deleted && chapter.payload) {
      await write("BookChapter", articleId, { payload: { ...chapter.payload, isSegmented: true } });
    }
  });
}

export function dedupeSegments<T extends { id: string; payload: ArticleSegment }>(rows: T[]): T[] {
  const byOrder = new Map<string, T>();
  const score = (row: T) => (row.payload.explanation ? 4 : 0) + (row.payload.translation ? 2 : 0) + (row.payload.readingText ? 1 : 0);
  for (const row of rows) {
    const key = `${row.payload.articleId.toLowerCase()}:${row.payload.order}`;
    const existing = byOrder.get(key);
    const revision = row.payload.segmentationRevision ?? 0;
    const oldRevision = existing?.payload.segmentationRevision ?? 0;
    if (!existing || revision > oldRevision || (revision === oldRevision && (score(row) > score(existing) || (score(row) === score(existing) && row.id < existing.id)))) {
      byOrder.set(key, row);
    }
  }
  return [...byOrder.values()].sort((a, b) => a.payload.order - b.payload.order);
}
