import { BookPlus, FileText, Loader2, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Article, Book, BookChapter, BookProgress } from "@openkoto/core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { HttpError } from "../lib/api";
import { parseEpub, parseTxt, sha256Hex } from "../lib/books";
import { useLibrary, useRecords } from "../lib/library";
import { useSession } from "../lib/session";
import { ensureSegments } from "../lib/segments";

async function uploadFile(bookId: string, bytes: Uint8Array, ext: string, sha: string): Promise<void> {
  const res = await fetch(`/api/v1/books/${bookId}/file?ext=${ext}&sha256=${sha}`, {
    method: "PUT",
    body: bytes as BodyInit,
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new HttpError(res.status, body.error?.code ?? "UPLOAD_FAILED", body.error?.message ?? res.statusText);
  }
}

export function LibraryPage() {
  const { t } = useTranslation();
  const { store, write } = useLibrary();
  const { account } = useSession();
  const books = useRecords<Book>("Book");
  const progress = useRecords<BookProgress>("BookProgress");
  const articles = useRecords<Article>("Article");
  const chapters = useRecords<BookChapter>("BookChapter");
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [showArticle, setShowArticle] = useState(false);

  const chapterIds = useMemo(() => new Set((chapters ?? []).map((c) => c.id)), [chapters]);
  const plainArticles = (articles ?? []).filter((a) => a.payload.sourceType !== "lyrics" && a.payload.sourceType !== "book" && !chapterIds.has(a.id));
  const progressFor = (bookId: string) => progress?.find((p) => p.id === bookId)?.payload;
  const bookLimit = account?.plan === "free" ? 5 : null;

  const importBook = async (file: File) => {
    setError(null);
    if (bookLimit !== null && (books?.length ?? 0) >= bookLimit) {
      setError(t("library.quota"));
      return;
    }
    if (account?.plan === "free" && file.size > 10 * 1024 * 1024) {
      setError(t("library.tooLarge"));
      return;
    }
    setBusy(file.name);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = file.name.toLowerCase().endsWith(".epub") ? "epub" : "txt";
      const parsed = ext === "epub" ? parseEpub(bytes, file.name) : parseTxt(bytes, file.name);
      const bookId = crypto.randomUUID();
      const sha = await sha256Hex(bytes);
      await uploadFile(bookId, bytes, ext, sha);
      const now = new Date().toISOString();
      const totalChars = parsed.chapters.reduce((n, c) => n + c.text.length, 0);
      await write("Book", bookId, {
        payload: {
          id: bookId,
          title: parsed.title,
          author: parsed.author,
          language: parsed.language,
          format: parsed.format,
          dirName: bookId,
          totalChars,
          defaultMode: "native",
          originalOnly: false,
          createdAt: now,
          fileSha256: sha,
          fileSize: bytes.byteLength,
        },
      });
      for (const [index, ch] of parsed.chapters.entries()) {
        const articleId = crypto.randomUUID();
        await write("Article", articleId, { payload: { id: articleId, title: ch.title, content: ch.text, sourceType: "book", createdAt: now } });
        await write("BookChapter", articleId, { payload: { articleId, bookId, index, title: ch.title, isSegmented: false, charCount: ch.text.length } });
      }
    } catch (err) {
      setError(err instanceof HttpError && err.code === "QUOTA_EXCEEDED" ? t("library.quota") : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const removeBook = async (book: Book) => {
    for (const ch of (chapters ?? []).filter((c) => c.payload.bookId.toLowerCase() === book.id.toLowerCase())) {
      await write("Article", ch.id, { deleted: true });
      await write("BookChapter", ch.id, { deleted: true });
    }
    await write("BookProgress", book.id.toLowerCase(), { deleted: true });
    await write("Book", book.id, { deleted: true });
    await fetch(`/api/v1/books/${book.id}/file`, { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  };

  const addArticle = async () => {
    if (!draft.content.trim()) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await write("Article", id, { payload: { id, title: draft.title.trim() || draft.content.trim().slice(0, 30), content: draft.content, sourceType: "article", createdAt: now } });
    await ensureSegments(store, write, id, draft.content);
    setDraft({ title: "", content: "" });
    setShowArticle(false);
  };

  if (!books) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold mr-auto">
          {t("library.title")} {bookLimit && <span className="text-base font-normal text-muted-foreground">{books.length}/{bookLimit}</span>}
        </h1>
        <Button variant="outline" size="sm" onClick={() => setShowArticle((v) => !v)}>
          <FileText size={16} /> {t("library.newArticle")}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => fileInput.current?.click()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <BookPlus size={16} />} {t("library.importBook")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".epub,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importBook(f);
            e.target.value = "";
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("library.hint")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {showArticle && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <Input placeholder={t("library.articleTitle")} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label={t("library.articleTitle")} />
          <Textarea rows={8} placeholder={t("library.articlePlaceholder")} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} aria-label={t("library.articleBody")} />
          <div className="flex justify-end">
            <Button onClick={() => void addArticle()} disabled={!draft.content.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">{t("library.books")}</h2>
        {books.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">{t("library.noBooks")}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {books.map(({ id, payload: b }) => {
              const p = progressFor(id);
              const count = (chapters ?? []).filter((c) => c.payload.bookId.toLowerCase() === id).length;
              return (
                <li key={id} className="rounded-xl border border-border bg-card p-4 flex gap-3">
                  <Link to={`/read/${id}`} className="flex-1 min-w-0">
                    <p className="font-medium truncate">{b.title}</p>
                    <p className="text-sm text-muted-foreground truncate">{b.author ?? b.format.toUpperCase()}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      {count ? t("library.progress", { current: (p?.chapterIndex ?? 0) + 1, total: count }) : t("library.syncingChapters")}
                    </p>
                  </Link>
                  <Button variant="ghost" size="sm" onClick={() => void removeBook({ ...b, id })} title={t("common.delete")}>
                    <Trash2 size={16} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {plainArticles.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium">{t("library.articles")}</h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {plainArticles.map((a) => (
              <li key={a.id} className="flex items-center gap-3 p-3">
                <Link to={`/read/article:${a.id}`} className="flex-1 min-w-0 truncate">
                  {a.payload.title}
                </Link>
                <Button variant="ghost" size="sm" onClick={() => void write("Article", a.id, { deleted: true })} title={t("common.delete")}>
                  <Trash2 size={16} />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
