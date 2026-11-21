import { ChevronLeft, ChevronRight, Languages, Loader2, Rocket } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import type { Article, ArticleSegment, Book, BookChapter, BookProgress } from "@openkoto/core";
import { AiSettings, useAiMode } from "../components/AiSettings";
import { SegmentReader, type SegmentRow } from "../components/SegmentReader";
import { Button } from "../components/ui/button";
import { aiEngine } from "../lib/ai";
import { request } from "../lib/api";
import { useLibrary, useRecord, useRecords } from "../lib/library";
import { dedupeSegments, ensureSegments } from "../lib/segments";

function useSegments(articleId: string | undefined): SegmentRow[] | undefined {
  const { store } = useLibrary();
  return useLiveQuery(async () => {
    if (!articleId) return [];
    return dedupeSegments(
      (await store.children("Segment", articleId)).map((r) => ({ id: r.id, payload: r.payload as unknown as ArticleSegment })),
    );
  }, [store, articleId]);
}

export function ReaderPage() {
  const { t } = useTranslation();
  const { bookId: param = "" } = useParams();
  const { store, write, sync } = useLibrary();
  const isArticle = param.startsWith("article:");
  const bookId = isArticle ? undefined : param.toLowerCase();
  const book = useRecord<Book>("Book", bookId);
  const allChapters = useRecords<BookChapter>("BookChapter");
  const progress = useRecord<BookProgress>("BookProgress", bookId);
  const [, bump] = useState(0);
  const { mode, target } = useAiMode();

  const chapters = useMemo(
    () => (allChapters ?? []).filter((c) => c.payload.bookId.toLowerCase() === bookId).sort((a, b) => a.payload.index - b.payload.index),
    [allChapters, bookId],
  );
  const [index, setIndex] = useState<number | null>(null);
  const chapterIndex = index ?? progress?.payload.chapterIndex ?? 0;
  const chapter = chapters[chapterIndex];
  const articleId = isArticle ? param.slice("article:".length).toLowerCase() : chapter?.id;
  const article = useRecord<Article>("Article", articleId);
  const segments = useSegments(articleId);
  const [showTranslation, setShowTranslation] = useState(true);
  const [translating, setTranslating] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Chapters are segmented lazily on first open (design §8.2).
  useEffect(() => {
    if (!article || !articleId || segments === undefined || segments.length || sync.status === "syncing") return;
    void ensureSegments(store, write, articleId, article.payload.content).catch((err: unknown) => {
      setMessage(err instanceof Error ? err.message : String(err));
    });
  }, [article, articleId, segments, store, write, sync.status]);

  const saveProgress = useCallback(
    async (i: number) => {
      if (!bookId) return;
      const ch = chapters[i];
      await write("BookProgress", bookId, {
        payload: { bookId, chapterArticleId: ch?.id ?? null, chapterIndex: i, segmentOrder: null, scrollFraction: 0, mode: "native", updatedAt: new Date().toISOString() },
      });
    },
    [bookId, chapters, write],
  );

  const go = (i: number) => {
    setIndex(i);
    window.scrollTo({ top: 0 });
    void saveProgress(i);
  };

  const translateChapter = async () => {
    if (!mode || !segments?.length) return;
    const pending = segments.filter((s) => !s.payload.translation && s.payload.text.trim());
    setTranslating(`0/${pending.length}`);
    setMessage(null);
    try {
      const result = await aiEngine(mode).translateItems(
        pending.map((s) => ({ id: s.id, text: s.payload.text })),
        target,
        { bookTitle: book?.payload.title, chapterTitle: article?.payload.title },
      );
      for (const s of pending) {
        const tr = result.get(s.id);
        if (tr) await write("Segment", s.id, { payload: { ...s.payload, translation: tr } as never });
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTranslating(null);
    }
  };

  const translateWholeBook = async () => {
    if (!bookId) return;
    try {
      const job = await request<{ total: number }>("/api/v1/jobs", { method: "POST", body: JSON.stringify({ kind: "translate_book", bookId, targetLanguage: target }) });
      setMessage(t("reader.jobStarted", { count: job.total }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isArticle && book === null) return <p className="text-muted-foreground">{t("reader.notFound")}</p>;
  if (!article) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/library" className="text-sm text-muted-foreground hover:text-foreground">
          ← {t("nav.library")}
        </Link>
        <h1 className="text-lg font-semibold basis-full">{book?.payload.title ?? article.payload.title}</h1>
        {!isArticle && (
          <select
            className="h-9 max-w-[16rem] rounded-md border border-input bg-background px-2 text-sm"
            value={chapterIndex}
            onChange={(e) => go(Number(e.target.value))}
            aria-label={t("reader.chapter")}
          >
            {chapters.map((c, i) => (
              <option key={c.id} value={i}>
                {(c.payload as BookChapter & { title?: string }).title ?? `#${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="outline" onClick={() => setShowTranslation((v) => !v)}>
          <Languages size={16} /> {showTranslation ? t("reader.hideTranslation") : t("reader.showTranslation")}
        </Button>
        <Button size="sm" disabled={!mode || !!translating || !segments?.length} onClick={() => void translateChapter()}>
          {translating ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />} {t("reader.translateChapter")}
        </Button>
        {!isArticle && mode === "hosted" && (
          <Button size="sm" variant="secondary" onClick={() => void translateWholeBook()}>
            <Rocket size={16} /> {t("reader.translateBook")}
          </Button>
        )}
        <AiSettings onChange={() => bump((n) => n + 1)} />
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {!segments?.length ? (
        <p className="text-muted-foreground">{t("reader.preparing")}</p>
      ) : (
        <SegmentReader segments={segments} articleId={articleId!} articleTitle={article.payload.title} mode={mode} target={target} showTranslation={showTranslation} />
      )}

      {!isArticle && (
        <div className="flex justify-between pt-6">
          <Button variant="outline" disabled={chapterIndex <= 0} onClick={() => go(chapterIndex - 1)}>
            <ChevronLeft size={16} /> {t("reader.prev")}
          </Button>
          <Button variant="outline" disabled={chapterIndex >= chapters.length - 1} onClick={() => go(chapterIndex + 1)}>
            {t("reader.next")} <ChevronRight size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
