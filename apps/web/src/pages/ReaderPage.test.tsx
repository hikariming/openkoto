import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyncEngine } from "@openkoto/client";
import { IndexedDbStore } from "../lib/store";
import { ReaderPage } from "./ReaderPage";

const article = {id:"article",payload:{id:"article",title:"Test",content:"猫です。\n空です。",sourceType:"article",createdAt:"2026-11-21T00:00:00Z"}};
let library: { store: IndexedDbStore; write: ReturnType<typeof vi.fn>; sync: {status:string} };
let engine: SyncEngine;
vi.mock("../lib/library", () => ({
  useLibrary: () => library,
  useRecord: (type: string) => type === "Article" ? article : null,
  useRecords: () => [],
}));
vi.mock("../components/AiSettings", () => ({ AiSettings: () => null, useAiMode: () => ({mode:null,target:"en"}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({t:(key: string)=>key}) }));

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const store = new IndexedDbStore(crypto.randomUUID());
  engine = new SyncEngine({store,transport:{pull:async () => {throw new Error("unused");},push:async () => {throw new Error("unused");}}});
  library = {store,write:vi.fn(async (...args: Parameters<typeof engine.recordLocalChange>) => {await engine.recordLocalChange(...args);}),sync:{status:"idle"}};
  await engine.recordLocalChange("Article","article",{payload:article.payload});
});
afterEach(async () => {
  await library.store.db.delete();
  vi.unstubAllGlobals();
});
function reader() {
  return <StrictMode><MemoryRouter initialEntries={["/read/article:article"]}><Routes><Route path="/read/:bookId" element={<ReaderPage />} /></Routes></MemoryRouter></StrictMode>;
}
async function remoteSegments(duplicates = false) {
  for (const [order,text] of ["猫です。","空です。"].entries()) {
    for (let copy=0;copy<(duplicates?2:1);copy++) {
      const id=`remote-${order}-${copy}`;
      await engine.recordLocalChange("Segment",id,{payload:{id,articleId:"article",order,text,isNewParagraph:true,createdAt:article.payload.createdAt}});
    }
  }
}

it("refreshes an existing affected article without creating segments and renders each order once", async () => {
  await remoteSegments(true);
  const first=render(reader());
  await screen.findByRole("button",{name:"猫です。"});
  expect(screen.getAllByRole("button",{name:"猫です。"})).toHaveLength(1);
  expect(library.write).not.toHaveBeenCalled();
  first.unmount();
  render(reader());
  await screen.findByRole("button",{name:"空です。"});
  expect(await library.store.children("Segment","article")).toHaveLength(4);
  expect(library.write).not.toHaveBeenCalled();
});

it("waits for a delayed segment sync page instead of segmenting the already-loaded article", async () => {
  library.sync.status="syncing";
  const view=render(reader());
  await screen.findByText("reader.preparing");
  await act(async () => {await library.store.children("Segment","article");});
  expect(library.write).not.toHaveBeenCalled();
  await act(async () => {await remoteSegments();});
  library.sync.status="idle";
  view.rerender(reader());
  await screen.findByRole("button",{name:"猫です。"});
  await waitFor(() => expect(screen.getAllByRole("button",{name:"空です。"})).toHaveLength(1));
  expect(await library.store.children("Segment","article")).toHaveLength(2);
  expect(library.write).not.toHaveBeenCalled();
});
