import { Download, Pause, Play, Plus, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { retentionBand, type FavoriteVocabulary, type WordPack } from "@openkoto/core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useLibrary, useRecords } from "../lib/library";
import { useSession } from "../lib/session";
import { addVocabulary, deleteVocabulary, newPack, normalizeWord, parseWordList, setMembership, setSuspended } from "../lib/vocab";
import { cn } from "../lib/utils";

const BAND_COLOR: Record<string, string> = {
  new: "bg-muted-foreground/40",
  strong: "bg-[var(--srs-strong)]",
  fading: "bg-[var(--srs-fading)]",
  weak: "bg-[var(--srs-weak)]",
};

export function VocabPage() {
  const { t } = useTranslation();
  const { store, write, sync } = useLibrary();
  const { account } = useSession();
  const rows = useRecords<FavoriteVocabulary>("Vocabulary");
  const packs = useRecords<WordPack>("WordPack");
  const [query, setQuery] = useState("");
  const [packId, setPackId] = useState<string>("all");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ word: "", meaning: "", reading: "", example: "" });
  const [newPackName, setNewPackName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const wordInput = useRef<HTMLInputElement>(null);

  const cards = useMemo(() => (rows ?? []).map((r) => r.payload), [rows]);
  const visible = useMemo(() => {
    const q = normalizeWord(query);
    return cards
      .filter((c) => packId === "all" || (c.packIds ?? []).includes(packId))
      .filter((c) => !q || normalizeWord(c.word).includes(q) || c.meaning.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [cards, packId, query]);

  const limit = account?.plan === "free" ? 200 : null;
  const quotaRejected = sync.status === "idle" && sync.report?.rejected.some((r) => r.code === "QUOTA_EXCEEDED");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.word.trim()) return;
    const card = await addVocabulary(store, write, draft);
    if (packId !== "all" && !(card.packIds ?? []).includes(packId)) await setMembership(write, card, packId, true);
    setDraft({ word: "", meaning: "", reading: "", example: "" });
    wordInput.current?.focus();
  };

  const importFile = async (file: File) => {
    const drafts = parseWordList(await file.text());
    for (const d of drafts) {
      await addVocabulary(store, write, d);
    }
  };

  const exportCsv = () => {
    const lines = visible.map((c) => [c.word, c.meaning, c.reading ?? "", c.example ?? ""].map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([`word,meaning,reading,example\n${lines.join("\n")}`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "openkoto-vocabulary.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const createPack = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPackName.trim()) return;
    const pack = newPack(newPackName);
    await write("WordPack", pack.id, { payload: pack as never });
    setNewPackName("");
    setPackId(pack.id);
  };

  if (!rows) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold mr-auto">
          {t("vocab.title")} <span className="text-muted-foreground text-base font-normal">{limit ? `${cards.length}/${limit}` : cards.length}</span>
        </h1>
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> {t("vocab.import")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!visible.length}>
          <Download size={16} /> {t("vocab.export")}
        </Button>
        <Button size="sm" onClick={() => setAdding((v) => !v)}>
          <Plus size={16} /> {t("vocab.add")}
        </Button>
      </div>

      {(quotaRejected || (limit !== null && cards.length >= limit)) && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">{t("vocab.quota", { limit })}</p>
      )}

      {adding && (
        <form onSubmit={submit} className="grid gap-2 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
          <Input ref={wordInput} required placeholder={t("vocab.word")} value={draft.word} onChange={(e) => setDraft({ ...draft, word: e.target.value })} aria-label={t("vocab.word")} autoFocus />
          <Input placeholder={t("vocab.reading")} value={draft.reading} onChange={(e) => setDraft({ ...draft, reading: e.target.value })} aria-label={t("vocab.reading")} />
          <Input placeholder={t("vocab.meaning")} value={draft.meaning} onChange={(e) => setDraft({ ...draft, meaning: e.target.value })} aria-label={t("vocab.meaning")} />
          <Input placeholder={t("vocab.example")} value={draft.example} onChange={(e) => setDraft({ ...draft, example: e.target.value })} aria-label={t("vocab.example")} />
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit">{t("common.save")}</Button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" placeholder={t("vocab.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("vocab.search")} />
        </div>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={packId}
          onChange={(e) => setPackId(e.target.value)}
          aria-label={t("vocab.pack")}
        >
          <option value="all">{t("vocab.allPacks")}</option>
          {(packs ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.payload.name}
            </option>
          ))}
        </select>
        <form onSubmit={createPack} className="flex gap-2">
          <Input className="w-36" placeholder={t("vocab.newPack")} value={newPackName} onChange={(e) => setNewPackName(e.target.value)} aria-label={t("vocab.newPack")} />
          <Button type="submit" variant="secondary" size="sm" disabled={!newPackName.trim()}>
            {t("vocab.createPack")}
          </Button>
        </form>
      </div>

      {visible.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{cards.length ? t("vocab.noMatch") : t("vocab.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {visible.map((c) => {
            const band = retentionBand(c);
            return (
              <li key={c.id} className={cn("flex items-start gap-3 p-3", c.suspendedAt && "opacity-50")}>
                <span className={cn("mt-2 h-2 w-2 rounded-full shrink-0", BAND_COLOR[band])} title={t(`vocab.band.${band}`)} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">
                    {c.word} {c.reading && <span className="text-sm text-muted-foreground font-normal">{c.reading}</span>}
                  </p>
                  <p className="text-sm text-muted-foreground">{c.meaning}</p>
                  {c.example && <p className="text-xs text-muted-foreground mt-1 italic">{c.example}</p>}
                  <p className="text-xs text-muted-foreground mt-1">{t("vocab.due", { date: c.dueDate })}</p>
                </div>
                {packId !== "all" && (
                  <Button variant="ghost" size="sm" onClick={() => void setMembership(write, c, packId, false)}>
                    {t("vocab.removeFromPack")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => void setSuspended(write, c, !c.suspendedAt)} title={c.suspendedAt ? t("vocab.resume") : t("vocab.suspend")}>
                  {c.suspendedAt ? <Play size={16} /> : <Pause size={16} />}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void deleteVocabulary(write, c)} title={t("common.delete")}>
                  <Trash2 size={16} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
