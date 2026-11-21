// Extraction and repair of JSON from LLM responses.
// Port of desktop ai_service.rs (extract_json / extract_json_array / repair_json)
// and iOS OKAIClient.LLMJSONExtractor. Pipeline: extract → parse → repair → parse.

import type { SegmentExplanation, VocabularyItem } from "./models";
import { dedupeVocabulary } from "./vocabulary";

type Bracket = "{" | "[";
const CLOSING: Record<Bracket, string> = { "{": "}", "[": "]" };

function balancedSlice(content: string, open: Bracket): string | null {
  const start = content.indexOf(open);
  if (start < 0) return null;
  const close = CLOSING[open];
  let balance = 0;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === open) balance++;
    else if (c === close && --balance === 0) return content.slice(start, i + 1);
  }
  return null;
}

function fromCodeFence(content: string): string | null {
  // 1. ```json … last ``` (Rust rfind)
  const jsonFence = content.indexOf("```json");
  if (jsonFence >= 0) {
    const end = content.lastIndexOf("```");
    if (end - jsonFence > 7) return content.slice(jsonFence + 7, end).trim();
  }
  // 2. generic ``` … next ```
  const fence = content.indexOf("```");
  if (fence >= 0) {
    const end = content.indexOf("```", fence + 3);
    if (end >= 0) return content.slice(fence + 3, end).trim();
  }
  return null;
}

/** Likely JSON object text inside a model response. */
export function extractJson(content: string): string {
  const fenced = fromCodeFence(content);
  if (fenced !== null) return fenced;
  const braced = balancedSlice(content, "{");
  if (braced !== null) return braced;

  let trimmed = content.trim();
  if (trimmed.startsWith("```json")) trimmed = trimmed.slice(7);
  else if (trimmed.startsWith("```")) trimmed = trimmed.slice(3);
  if (trimmed.endsWith("```")) trimmed = trimmed.slice(0, -3);
  return trimmed.trim();
}

/** Likely JSON array text inside a model response. */
export function extractJsonArray(content: string): string {
  const fenced = fromCodeFence(content);
  if (fenced !== null) return fenced;
  return balancedSlice(content, "[") ?? content.trim();
}

const WS = new Set([" ", "\t", "\r", "\n"]);
const AFTER_CLOSE = new Set([",", ":", "}", "]"]);

/**
 * Repair common LLM JSON mistakes: raw newlines inside strings, smart quotes,
 * unescaped inner quotes (closing-quote heuristic), trailing commas.
 */
export function repairJson(json: string): string {
  const chars = Array.from(json);
  const len = chars.length;
  let out = "";
  let inString = false;

  for (let i = 0; i < len; i++) {
    const ch = chars[i]!;
    if (!inString) {
      if (ch === '"' || ch === "“") {
        inString = true;
        out += '"';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === "\\") {
      out += ch;
      if (++i < len) out += chars[i];
    } else if (ch === '"' || ch === "”") {
      // Structural closing quote iff the next non-whitespace is , : } ] or EOF.
      let j = i + 1;
      while (j < len && WS.has(chars[j]!)) j++;
      if (j >= len || AFTER_CLOSE.has(chars[j]!)) {
        inString = false;
        out += '"';
      } else {
        out += '\\"';
      }
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch !== "\r") {
      out += ch;
    }
  }

  return out.replace(/,(\s*\})/g, "$1").replace(/,(\s*\])/g, "$1");
}

export class LlmJsonError extends Error {
  constructor(
    message: string,
    readonly candidate: string,
  ) {
    super(message);
    this.name = "LlmJsonError";
  }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Extract → parse → repair → parse. Throws `LlmJsonError` when both attempts fail
 * or the value is not of the expected shape. The raw response is not included in the message.
 */
export function parseLlmJson(content: string, expect: "object" | "array" = "object"): unknown {
  const candidate = expect === "array" ? extractJsonArray(content) : extractJson(content);
  const matches = (v: unknown) =>
    expect === "array" ? Array.isArray(v) : typeof v === "object" && v !== null && !Array.isArray(v);

  for (const text of [candidate, repairJson(candidate)]) {
    const result = tryParse(text);
    if (result.ok && matches(result.value)) return result.value;
  }
  throw new LlmJsonError(`model response is not a valid JSON ${expect}`, candidate);
}

const snakeToCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Recursively convert snake_case keys to camelCase (Swift `.convertFromSnakeCase`). */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeToCamel(k), camelizeKeys(v)]));
  }
  return value;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toVocabularyItem(raw: unknown): VocabularyItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const word = str(o.word);
  const meaning = str(o.meaning);
  if (word === undefined || meaning === undefined) return null;
  return { word, meaning, usage: optStr(o.usage), example: optStr(o.example), reading: optStr(o.reading) };
}

/** Parse an `explain` response into a SegmentExplanation. */
export function parseSegmentExplanation(content: string): SegmentExplanation {
  const o = camelizeKeys(parseLlmJson(content)) as Record<string, unknown>;
  const translation = str(o.translation);
  const explanation = str(o.explanation);
  if (translation === undefined || explanation === undefined) {
    throw new LlmJsonError("explanation response is missing translation/explanation", JSON.stringify(o));
  }
  const vocabulary = dedupeVocabulary((Array.isArray(o.vocabulary) ? o.vocabulary : [])
    .map(toVocabularyItem)
    .filter((v): v is VocabularyItem => v !== null));
  const grammarPoints = (Array.isArray(o.grammarPoints) ? o.grammarPoints : []).flatMap((g) => {
    const p = g as Record<string, unknown> | null;
    const point = str(p?.point);
    const expl = str(p?.explanation);
    return point !== undefined && expl !== undefined ? [{ point, explanation: expl, example: optStr(p?.example) }] : [];
  });
  return {
    translation,
    explanation,
    readingText: optStr(o.readingText),
    vocabulary,
    grammarPoints,
    culturalContext: optStr(o.culturalContext),
    difficultyLevel: optStr(o.difficultyLevel),
    learningTips: optStr(o.learningTips),
  };
}

/** Parse a `wordGloss` response. */
export function parseWordGloss(content: string): VocabularyItem {
  const item = toVocabularyItem(parseLlmJson(content));
  if (!item) throw new LlmJsonError("gloss response is missing word/meaning", "");
  return item;
}
