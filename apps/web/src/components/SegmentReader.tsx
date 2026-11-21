import { BookmarkPlus, Languages, Loader2, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { dedupeVocabulary, normalizeWord, type ArticleSegment, type SegmentExplanation } from "@openkoto/core";
import { aiEngine, type AiMode } from "../lib/ai";
import { useLibrary } from "../lib/library";
import { addVocabulary } from "../lib/vocab";
import { dedupeSegments } from "../lib/segments";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface SegmentRow {
  id: string;
  payload: ArticleSegment;
}

interface Props {
  segments: SegmentRow[];
  articleId: string;
  articleTitle: string;
  mode: AiMode | null;
  target: string;
  showTranslation: boolean;
  /** Highlighted segment (lyrics playback). */
  activeId?: string | null;
  lineMode?: boolean;
}

/** Sentence-by-sentence reader with inline translation, AI explanation and "save word". */
export function SegmentReader({ segments, articleId, articleTitle, mode, target, showTranslation, activeId, lineMode }: Props) {
  const { t } = useTranslation();
  const { store, write } = useLibrary();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = segments.find((seg) => seg.id === selectedId) ?? null;
  const selectionVersion = useRef(0);
  const [generated, setGenerated] = useState<{ id: string; explanation: SegmentExplanation } | null>(null);
  const explanation = generated?.id === selectedId ? generated.explanation : selected?.payload.explanation ?? null;
  const inFlight = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState(new Set<string>());
  const busy = selectedId !== null && busyIds.has(selectedId);
  const pendingSaves = useRef(new Set<string>());
  const [savingWords, setSavingWords] = useState(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const open = (seg: SegmentRow) => {
    selectionVersion.current++;
    setSelectedId(seg.id);
    setGenerated(null);
    setError(null);
    setSaved(null);
  };

  const explain = async (regenerate = false) => {
    if (!selected || !mode) return;
    if (!regenerate && explanation) return;
    const id = selected.id;
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setBusyIds(new Set(inFlight.current));
    const version = selectionVersion.current;
    setError(null);
    try {
      const result = await aiEngine(mode).explain(selected.payload.text, target);
      const written = await store.transaction(async () => {
        const record = await store.getRecord("Segment", id);
        if (!record?.payload || record.deleted) return false;
        const latest = record.payload as unknown as ArticleSegment;
        await write("Segment", id, {
          payload: { ...latest, explanation: result, translation: latest.translation || result.translation } as never,
        });
        return true;
      });
      if (written && selectionVersion.current === version) setGenerated({ id, explanation: result });
    } catch (err) {
      if (selectionVersion.current === version) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current.delete(id);
      setBusyIds(new Set(inFlight.current));
    }
  };

  const saveWord = async (word: string, meaning: string, reading?: string | null) => {
    if (!selected) return;
    const key = normalizeWord(word);
    if (pendingSaves.current.has(key)) return;
    pendingSaves.current.add(key);
    setSavingWords(new Set(pendingSaves.current));
    const version = selectionVersion.current;
    try {
      await addVocabulary(store, write, {
        word,
        meaning,
        reading: reading ?? undefined,
        example: selected.payload.text,
        sourceArticleId: articleId,
        sourceArticleTitle: articleTitle,
        sourceSegmentId: selected.id,
      });
      if (selectionVersion.current === version) setSaved(word);
    } catch (err) {
      if (selectionVersion.current === version) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingSaves.current.delete(key);
      setSavingWords(new Set(pendingSaves.current));
    }
  };

  const saveSelection = async () => {
    const text = window.getSelection()?.toString().trim();
    if (!text || text.length > 60) return;
    await saveWord(text, "");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className={cn("leading-relaxed", lineMode ? "space-y-3" : "space-y-1")}>
        {dedupeSegments(segments).map((seg) => (
          <div key={seg.id} className={cn(seg.payload.isNewParagraph && !lineMode && "mt-4")}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => open(seg)}
              onKeyDown={(e) => e.key === "Enter" && open(seg)}
              className={cn(
                "cursor-pointer rounded px-0.5 transition-colors hover:bg-accent",
                selected?.id === seg.id && "bg-accent",
                activeId === seg.id && "bg-primary/15 text-primary font-medium",
                lineMode ? "block text-lg" : "",
              )}
            >
              {seg.payload.readingText && <span className="block text-xs text-muted-foreground">{seg.payload.readingText}</span>}
              {seg.payload.text}
            </span>
            {showTranslation && seg.payload.translation && <span className={cn("block text-sm text-muted-foreground", !lineMode && "mb-2")}>{seg.payload.translation}</span>}
          </div>
        ))}
      </div>

      <aside className="lg:sticky lg:top-20 self-start rounded-xl border border-border bg-card p-4 space-y-3 text-sm">
        {!selected ? (
          <p className="text-muted-foreground">{t("reader.pickSentence")}</p>
        ) : (
          <>
            <p className="font-medium">{selected.payload.text}</p>
            {selected.payload.translation && (
              <p className="flex gap-2 text-muted-foreground">
                <Languages size={16} className="shrink-0 mt-0.5" aria-hidden /> {selected.payload.translation}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={!mode || busy} onClick={() => void explain()}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {t("reader.explain")}
              </Button>
              {explanation && (
                <Button size="sm" variant="outline" disabled={!mode || busy} onClick={() => void explain(true)}>
                  {t("reader.regenerate")}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void saveSelection()} title={t("reader.saveSelectionHint")}>
                <BookmarkPlus size={14} /> {t("reader.saveSelection")}
              </Button>
            </div>
            {!mode && <p className="text-xs text-muted-foreground">{t("reader.noAi")}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {saved && <p className="text-xs text-primary">{t("reader.saved", { word: saved })}</p>}
            {explanation && (
              <div className="space-y-3 border-t border-border pt-3">
                {explanation.explanation && <p>{explanation.explanation}</p>}
                {explanation.vocabulary.length > 0 && (
                  <ul className="space-y-2">
                    {dedupeVocabulary(explanation.vocabulary).map((v) => (
                      <li key={normalizeWord(v.word)} className="flex items-start gap-2">
                        <div className="flex-1">
                          <p className="font-medium">
                            {v.word} {v.reading && <span className="text-xs text-muted-foreground">{v.reading}</span>}
                          </p>
                          <p className="text-muted-foreground">{v.meaning}</p>
                        </div>
                        <Button size="sm" variant="ghost" disabled={savingWords.has(normalizeWord(v.word))} onClick={() => void saveWord(v.word, v.meaning, v.reading)} title={t("reader.saveWord")}>
                          <BookmarkPlus size={14} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {explanation.grammarPoints.length > 0 && (
                  <ul className="space-y-1">
                    {explanation.grammarPoints.map((g) => (
                      <li key={g.point}>
                        <span className="font-medium">{g.point}</span> — <span className="text-muted-foreground">{g.explanation}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
