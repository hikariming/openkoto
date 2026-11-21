import { describe, expect, it } from "vitest";
import {
  LlmJsonError,
  camelizeKeys,
  extractJson,
  extractJsonArray,
  parseLlmJson,
  parseSegmentExplanation,
  parseWordGloss,
  repairJson,
} from "../src/llm-json";

describe("extractJson", () => {
  it("prefers ```json fences (last closing fence)", () => {
    expect(extractJson('text ```json\n{"a":1}\n``` more ```')).toBe('{"a":1}\n``` more');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("falls back to generic fences, then braces, then trimming", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Sure! {"a":{"b":2}} hope it helps')).toBe('{"a":{"b":2}}');
    expect(extractJson("  ```json\nnot json")).toBe("not json");
    expect(extractJson("{unclosed")).toBe("{unclosed");
  });
  it("extracts arrays", () => {
    expect(extractJsonArray('here: [{"i":1},[2]] done')).toBe('[{"i":1},[2]]');
    expect(extractJsonArray("```json\n[1]\n```")).toBe("[1]");
  });
});

describe("repairJson", () => {
  it("escapes raw newlines and drops CR", () => {
    expect(JSON.parse(repairJson('{"a":"x\r\ny"}'))).toEqual({ a: "x\ny" });
  });
  it("normalises smart quotes", () => {
    expect(JSON.parse(repairJson("{“a”: “b”}"))).toEqual({ a: "b" });
  });
  it("escapes inner quotes by the closing-quote heuristic", () => {
    expect(JSON.parse(repairJson('{"a": "he said "hi" to me", "b": 1}'))).toEqual({ a: 'he said "hi" to me', b: 1 });
  });
  it("keeps existing escapes and removes trailing commas", () => {
    expect(JSON.parse(repairJson('{"a": "q\\"x", "b": [1, 2,], }'))).toEqual({ a: 'q"x', b: [1, 2] });
  });
});

describe("parse pipeline", () => {
  it("parses directly or after repair", () => {
    expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLlmJson('{"a": "line\nbreak",}')).toEqual({ a: "line\nbreak" });
    expect(parseLlmJson('ok [1,2,]', "array")).toEqual([1, 2]);
  });
  it("throws LlmJsonError on garbage or wrong shape", () => {
    expect(() => parseLlmJson("no json here")).toThrow(LlmJsonError);
    expect(() => parseLlmJson("[1]", "object")).toThrow(LlmJsonError);
  });
  it("camelizes keys", () => {
    expect(camelizeKeys({ grammar_points: [{ some_key: 1 }], alreadyCamel: 2 })).toEqual({
      grammarPoints: [{ someKey: 1 }],
      alreadyCamel: 2,
    });
  });
  it("parses a segment explanation", () => {
    const raw = `Here you go:
\`\`\`json
{
  "translation": "你好",
  "explanation": "A "greeting".
Common.",
  "vocabulary": [{"word": "hello", "meaning": "你好", "reading": "həˈləʊ"}, {"bad": true}],
  "grammar_points": [{"point": "interjection", "explanation": "..." }],
  "cultural_context": null,
  "difficulty_level": "beginner",
  "learning_tips": "Say it often",
}
\`\`\``;
    const e = parseSegmentExplanation(raw);
    expect(e.translation).toBe("你好");
    expect(e.explanation).toBe('A "greeting".\nCommon.');
    expect(e.vocabulary).toEqual([{ word: "hello", meaning: "你好", reading: "həˈləʊ", usage: null, example: null }]);
    expect(e.grammarPoints).toEqual([{ point: "interjection", explanation: "...", example: null }]);
    expect(e.difficultyLevel).toBe("beginner");
    expect(e.culturalContext).toBeNull();
  });
  it("parses a word gloss", () => {
    expect(parseWordGloss('{"word":"走る","reading":"はしる","meaning":"跑","usage":"动词"}')).toMatchObject({
      word: "走る",
      meaning: "跑",
    });
    expect(() => parseWordGloss('{"word":"x"}')).toThrow(LlmJsonError);
  });
  it("deduplicates normalized words, keeping the first entry and filling empty fields", () => {
    const result = parseSegmentExplanation(JSON.stringify({
      translation: "translation", explanation: "explanation",
      vocabulary: [
        { word: " Ｈｅｌｌｏ ", meaning: "", reading: " ", usage: "first usage" },
        { word: "hello", meaning: "greeting", reading: "hello", usage: "later usage", example: "Hello!" },
        { word: "HELLO", meaning: "different" },
        { word: "猫", meaning: "cat" },
        { word: " 猫 ", meaning: "feline" },
        { bad: true },
      ],
    }));
    expect(result.vocabulary).toEqual([
      { word: " Ｈｅｌｌｏ ", meaning: "greeting", reading: "hello", usage: "first usage", example: "Hello!" },
      { word: "猫", meaning: "cat", reading: null, usage: null, example: null },
    ]);
  });
  it("handles absent, empty and invalid explanation vocabulary", () => {
    for (const vocabulary of [undefined, [], null, "bad", [{bad: true}]]) {
      expect(parseSegmentExplanation(JSON.stringify({ translation: "", explanation: "", vocabulary })).vocabulary).toEqual([]);
    }
    expect(() => parseSegmentExplanation('{"vocabulary":[]}')).toThrow(LlmJsonError);
  });
});
