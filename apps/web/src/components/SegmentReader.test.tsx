import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SegmentExplanation } from "@openkoto/core";
import { SegmentReader, type SegmentRow } from "./SegmentReader";

const mocks = vi.hoisted(() => ({ explain: vi.fn(), write: vi.fn(), addVocabulary: vi.fn(), getRecord: vi.fn() }));
vi.mock("../lib/ai", () => ({ aiEngine: () => ({ explain: mocks.explain }) }));
vi.mock("../lib/library", () => ({ useLibrary: () => ({ store: {getRecord:mocks.getRecord, transaction:async (fn: () => Promise<unknown>) => fn()}, write: mocks.write }) }));
vi.mock("../lib/vocab", () => ({ addVocabulary: mocks.addVocabulary }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const explanation: SegmentExplanation = {
  translation: "cat", explanation: "About a cat", grammarPoints: [],
  vocabulary: [{word:"猫", meaning:"cat"}, {word:" 猫 ", meaning:"", reading:"ねこ"}],
};
const rows: SegmentRow[] = [
  { id:"a", payload:{id:"a", articleId:"article", order:0, text:"猫です。", isNewParagraph:true, createdAt:"2026-11-21T00:00:00Z"} },
  { id:"b", payload:{id:"b", articleId:"article", order:1, text:"空です。", isNewParagraph:true, createdAt:"2026-11-21T00:00:00Z"} },
];
const props = { articleId:"article", articleTitle:"Test", mode:"byok" as const, target:"en", showTranslation:true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function open(text = "猫です。") { fireEvent.click(screen.getByRole("button", {name:text})); }
function explain() { fireEvent.click(screen.getByRole("button", {name:"reader.explain"})); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.write.mockResolvedValue(undefined);
  mocks.explain.mockResolvedValue(explanation);
  mocks.addVocabulary.mockResolvedValue({});
  mocks.getRecord.mockImplementation(async (_type: string, id: string) => ({payload:rows.find(r=>r.id===id)?.payload,deleted:false}));
});

describe("SegmentReader", () => {
  it("reuses saved explanations without requests on Explain, reopen or StrictMode rerender", () => {
    const saved = [{...rows[0]!, payload:{...rows[0]!.payload, explanation}}, rows[1]!];
    const view = render(<StrictMode><SegmentReader {...props} segments={saved} /></StrictMode>);
    open();
    explain();
    open("空です。");
    open();
    view.rerender(<StrictMode><SegmentReader {...props} segments={saved} /></StrictMode>);
    explain();
    expect(mocks.explain).not.toHaveBeenCalled();
    expect(screen.getByText("About a cat")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("ねこ")).toBeInTheDocument();
    expect(explanation.vocabulary).toHaveLength(2);
  });

  it("coalesces double Explain clicks and reuses the new result", async () => {
    const request = deferred<SegmentExplanation>();
    mocks.explain.mockReturnValue(request.promise);
    render(<SegmentReader {...props} segments={rows} />);
    open();
    explain();
    explain();
    expect(mocks.explain).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(explanation));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    explain();
    expect(mocks.explain).toHaveBeenCalledTimes(1);
  });

  it("only regenerates explicitly, once while busy", async () => {
    const request = deferred<SegmentExplanation>();
    mocks.explain.mockReturnValue(request.promise);
    render(<SegmentReader {...props} segments={[{...rows[0]!, payload:{...rows[0]!.payload, explanation}}]} />);
    open();
    explain();
    const button = screen.getByRole("button", {name:"reader.regenerate"});
    fireEvent.click(button);
    fireEvent.click(button);
    explain();
    expect(mocks.explain).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve({...explanation, explanation:"Regenerated"}));
    expect(screen.getByText("Regenerated")).toBeInTheDocument();
  });

  it("writes to the latest requesting row without displaying it on a different selection", async () => {
    const request = deferred<SegmentExplanation>();
    mocks.explain.mockReturnValue(request.promise);
    const view = render(<SegmentReader {...props} segments={rows} />);
    open();
    explain();
    mocks.getRecord.mockResolvedValue({payload:{...rows[0]!.payload,translation:"Latest translation",readingText:"Latest reading"},deleted:false});
    view.rerender(<SegmentReader {...props} segments={[{...rows[0]!, payload:{...rows[0]!.payload, translation:"Latest translation", readingText:"Latest reading"}}, rows[1]!]} />);
    open("空です。");
    await act(async () => request.resolve(explanation));
    expect(mocks.write).toHaveBeenCalledWith("Segment", "a", {payload:expect.objectContaining({translation:"Latest translation", readingText:"Latest reading", explanation})});
    expect(screen.queryByText("About a cat")).not.toBeInTheDocument();
    expect(screen.getAllByText("空です。")).toHaveLength(2);
  });

  it("persists a completed explanation even after its requesting chapter leaves the current rows", async () => {
    const request = deferred<SegmentExplanation>();
    mocks.explain.mockReturnValue(request.promise);
    const view = render(<SegmentReader {...props} segments={rows} />);
    open(); explain();
    view.rerender(<SegmentReader {...props} articleId="other-article" segments={[rows[1]!]} />);
    await act(async () => request.resolve(explanation));
    expect(mocks.write).toHaveBeenCalledWith("Segment", "a", {payload:expect.objectContaining({id:"a",explanation})});
    expect(screen.queryByText("About a cat")).not.toBeInTheDocument();
  });

  it("does not enqueue another request when returning to an in-flight segment", async () => {
    const request = deferred<SegmentExplanation>();
    mocks.explain.mockReturnValue(request.promise);
    render(<SegmentReader {...props} segments={rows} />);
    open(); explain(); open("空です。"); open(); explain();
    expect(mocks.explain).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(explanation));
    expect(screen.queryByText("About a cat")).not.toBeInTheDocument();
  });

  it("releases the request guard on error and supports retry", async () => {
    mocks.explain.mockRejectedValueOnce(new Error("AI unavailable"));
    render(<SegmentReader {...props} segments={rows} />);
    open(); explain();
    await screen.findByText("AI unavailable");
    explain();
    await screen.findByText("About a cat");
    expect(mocks.explain).toHaveBeenCalledTimes(2);
  });

  it("renders no selection and empty vocabulary without invoking AI", () => {
    const view = render(<SegmentReader {...props} segments={[]} />);
    expect(screen.getByText("reader.pickSentence")).toBeInTheDocument();
    view.rerender(<SegmentReader {...props} mode={null} segments={[{...rows[0]!,payload:{...rows[0]!.payload,explanation:{...explanation,vocabulary:[]}}}]} />);
    open();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByRole("button",{name:"reader.explain"})).toBeDisabled();
    expect(mocks.explain).not.toHaveBeenCalled();
  });

  it("guards pending word saves and releases the guard after failure", async () => {
    const save = deferred<void>();
    mocks.addVocabulary.mockReturnValueOnce(save.promise);
    render(<SegmentReader {...props} segments={[{...rows[0]!,payload:{...rows[0]!.payload,explanation}}]} />);
    open();
    const button = screen.getByTitle("reader.saveWord");
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(mocks.addVocabulary).toHaveBeenCalledTimes(1);
    await act(async () => save.reject(new Error("Save failed")));
    expect(screen.getByText("Save failed")).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(mocks.addVocabulary).toHaveBeenCalledTimes(2);
  });
});
