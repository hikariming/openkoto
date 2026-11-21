import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { SyncEngine, type LocalChange } from "@openkoto/client";
import type { FavoriteVocabulary } from "@openkoto/core";
import { IndexedDbStore } from "../store";
import { addVocabulary, gradeCard, newVocabulary, normalizeWord, parseWordList, undoReview } from "../vocab";

function recorder() {
  const writes: { type: string; id: string; change: LocalChange }[] = [];
  return { writes, write: async (type: string, id: string, change: LocalChange) => void writes.push({ type, id, change }) };
}

const stores: IndexedDbStore[] = [];
function database(userId: string = crypto.randomUUID()) {
  const store = new IndexedDbStore(userId);
  stores.push(store);
  const engine = new SyncEngine({ store, transport: { pull: async () => { throw new Error("unused"); }, push: async () => { throw new Error("unused"); } } });
  return { store, write: async (...args: Parameters<typeof engine.recordLocalChange>) => { await engine.recordLocalChange(...args); } };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.db.delete();
});

describe("vocab helpers", () => {
  it("normalizes with NFKC, trim and lowercase", () => {
    expect(normalizeWord(" Ｈｅｌｌｏ ")).toBe("hello");
  });

  it("merges duplicates by filling empty fields", async () => {
    const existing = newVocabulary({ word: "Hello", meaning: "" });
    const {store, write} = database();
    await write("Vocabulary", existing.id, {payload: existing as never});
    const merged = await addVocabulary(store, write, { word: "hello", meaning: "你好" });
    expect(merged.id).toBe(existing.id);
    expect(merged.meaning).toBe("你好");
    expect(await store.live("Vocabulary")).toHaveLength(1);
  });

  it("serializes concurrent saves across database connections and preserves sync metadata", async () => {
    const first = database();
    const second = database(first.store.db.name.slice("openkoto-".length));
    const cards = await Promise.all([
      addVocabulary(first.store, first.write, {word: " Ｃａｔ ", meaning: "cat"}),
      addVocabulary(second.store, second.write, {word: "cat", meaning: "different", reading: "キャット"}),
    ]);
    expect(cards[0]!.id).toBe(cards[1]!.id);
    const records = await first.store.live("Vocabulary");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({dirty:true, rev:0, type:"Vocabulary"});
    expect(records[0]!.opId).toBeTruthy();
    expect(records[0]!.payload).toMatchObject({meaning:"cat", reading:"キャット"});
    expect(await first.store.getMeta("hlc")).toBe(records[0]!.hlc);
    second.store.db.close();
  });

  it("ignores tombstones and rolls back failed writes", async () => {
    const {store, write} = database();
    const old = await addVocabulary(store, write, {word:"猫", meaning:"cat"});
    await write("Vocabulary", old.id, {deleted:true});
    await expect(addVocabulary(store, async (...args) => {
      await write(...args);
      throw new Error("write failed");
    }, {word:"猫", meaning:"cat"})).rejects.toThrow("write failed");
    expect(await store.live("Vocabulary")).toHaveLength(0);
    const card = await addVocabulary(store, write, {word:"猫", meaning:"cat"});
    expect(card.id).not.toBe(old.id);
    expect((await store.live("Vocabulary"))[0]!.payload as unknown as FavoriteVocabulary).toMatchObject({word:"猫"});
  });

  it("parses CSV and TSV word lists", () => {
    expect(parseWordList("# comment\n桜,cherry blossom,さくら\n空\tsky")).toEqual([
      { word: "桜", meaning: "cherry blossom", reading: "さくら", example: undefined },
      { word: "空", meaning: "sky", reading: undefined, example: undefined },
    ]);
  });

  it("grades with an immutable event and undoes with a void marker", async () => {
    const card = newVocabulary({ word: "桜", meaning: "cherry" });
    const r = recorder();
    const { card: next, event } = await gradeCard(r.write as never, card, 3);
    expect(next.reviewCount).toBe(1);
    expect(r.writes.map((w) => w.type)).toEqual(["ReviewEvent", "Vocabulary"]);
    await undoReview(r.write as never, card, event);
    const voidEvent = r.writes[2]!.change as { payload: { voidsEventId: string; grade: number } };
    expect(voidEvent.payload).toMatchObject({ voidsEventId: event.id, grade: 0 });
    const restored = r.writes[3]!.change as { payload: { reviewCount: number } };
    expect(restored.payload.reviewCount).toBe(0);
  });
});
