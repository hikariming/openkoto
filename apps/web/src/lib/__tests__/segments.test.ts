import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "@openkoto/client";
import type { ArticleSegment } from "@openkoto/core";
import { IndexedDbStore } from "../store";
import { dedupeSegments, ensureSegments, segmentId } from "../segments";

const stores: IndexedDbStore[] = [];
const content = "猫です。\n空です。";
function database(userId: string = crypto.randomUUID()) {
  const store = new IndexedDbStore(userId);
  stores.push(store);
  const engine = new SyncEngine({store, transport:{pull:async () => {throw new Error("unused");}, push:async () => {throw new Error("unused");}}});
  const write = async (...args: Parameters<typeof engine.recordLocalChange>) => { await engine.recordLocalChange(...args); };
  return {store, write};
}
async function seed(db: ReturnType<typeof database>) {
  await db.write("Article", "article", {payload:{id:"article",content}});
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(async () => {
  for (const store of stores.splice(0)) await store.db.delete();
  vi.unstubAllGlobals();
});

describe("reader segmentation", () => {
  it("is atomic across concurrent connections, deterministic across devices, and idempotent on refresh", async () => {
    const first = database();
    const second = database(first.store.db.name.slice("openkoto-".length));
    await seed(first);
    await Promise.all([ensureSegments(first.store, first.write, "article", content), ensureSegments(second.store, second.write, "article", content)]);
    const before = await first.store.children("Segment", "article");
    expect(before).toHaveLength(2);
    await ensureSegments(second.store, second.write, "article", content);
    expect(await first.store.children("Segment", "article")).toEqual(before);
    const otherDevice = database();
    await seed(otherDevice);
    await ensureSegments(otherDevice.store, otherDevice.write, "article", content);
    expect((await otherDevice.store.children("Segment", "article")).map(r => r.id)).toEqual(before.map(r => r.id));
    expect(await segmentId("ARTICLE", 0)).toBe(await segmentId("article", 0));
    expect(await segmentId("article", 1)).not.toBe(await segmentId("article", 0));
    second.store.db.close();
  });

  it("checks the database rather than an empty live-query snapshot and preserves existing explanations", async () => {
    const db = database();
    await seed(db);
    await db.write("Segment", "legacy", {payload:{articleId:"article",order:0,text:"猫です。",explanation:{translation:"cat",explanation:"saved",vocabulary:[],grammarPoints:[]}}});
    const before = await db.store.children("Segment", "article");
    await ensureSegments(db.store, db.write, "article", content);
    expect(await db.store.children("Segment", "article")).toEqual(before);
  });

  it("renders late synced legacy duplicates once, but preserves intentional repeated text at different orders", async () => {
    const db = database();
    await seed(db);
    await ensureSegments(db.store, db.write, "article", content);
    const local = await db.store.children("Segment", "article");
    const remote = local.map((r,i) => ({...r, id:`remote-${i}`, deviceId:"remote-device", rev:1, payload:{...r.payload,translation:"remote translation"}}));
    const engine = new SyncEngine({store:db.store, transport:{
      pull:async () => ({records:remote,cursor:"1",hasMore:false,serverTime:new Date().toISOString()}),
      push:async req => ({results:req.ops.map(op=>({opId:op.opId,status:"applied" as const,rev:2})),cursor:"2"}),
    }});
    await engine.sync();
    const all = await db.store.children("Segment", "article");
    expect(all).toHaveLength(4);
    const rows = all.map(r=>({id:r.id,payload:r.payload as unknown as ArticleSegment}));
    const visible = dedupeSegments(rows);
    expect(visible).toHaveLength(2);
    expect(visible.every(r=>r.payload.translation === "remote translation")).toBe(true);
    expect(dedupeSegments([...rows,{...visible[0]!,id:"intentional-repeat",payload:{...visible[0]!.payload,order:2}}])).toHaveLength(3);
  });

  it("does not segment deleted, changed or empty articles and rolls back failed segmentation", async () => {
    const db = database();
    await seed(db);
    await ensureSegments(db.store, db.write, "article", "stale content");
    expect(await db.store.children("Segment", "article")).toHaveLength(0);
    await expect(ensureSegments(db.store, async (...args) => {await db.write(...args);throw new Error("failed");}, "article", content)).rejects.toThrow("failed");
    expect(await db.store.children("Segment", "article")).toHaveLength(0);
    await db.write("Article", "article", {payload:{content:""}});
    await ensureSegments(db.store, db.write, "article", "");
    expect(await db.store.children("Segment", "article")).toHaveLength(0);
    await db.write("Article", "article", {deleted:true});
    await ensureSegments(db.store, db.write, "article", content);
    expect(await db.store.children("Segment", "article")).toHaveLength(0);
  });
});
