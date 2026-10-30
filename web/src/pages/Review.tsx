import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCheck, Copy, Files, Layers, ListChecks, Pencil, RefreshCw, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, formatBytes, get, type Person, type Proposal, type SeriesSuggestion } from "@/lib/api";
import { PageHeader, useEngine } from "@/components/Layout";
import { faceLabel, usePeople } from "@/components/people";
import { Badge, Button, EmptyState, Field, Input, Modal, PageSpinner, Segmented, Spinner, cn } from "@/components/ui";

type Tab = "look" | "ready" | "duplicates" | "series" | "done";

const needsLook = (p: Proposal) => p.status === "failed" || p.confidence !== "high" || !p.author || !p.title || (p.kind === "conflict" && !p.resolution);

export default function ReviewPage() {
  const qc = useQueryClient();
  const { status, scan } = useEngine();
  const people = usePeople();
  const pending = useQuery({ queryKey: ["proposals"], queryFn: () => get<Proposal[]>("/proposals") });
  const done = useQuery({ queryKey: ["proposals", "done"], queryFn: () => get<Proposal[]>("/proposals?status=done") });
  const series = useQuery({ queryKey: ["series"], queryFn: () => get<SeriesSuggestion[]>("/series") });
  const [tab, setTab] = useState<Tab>("ready");
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [confirm, setConfirm] = useState<Proposal[] | null>(null);

  const groups = useMemo(() => {
    const all = pending.data ?? [];
    return {
      look: all.filter(needsLook),
      ready: all.filter((p) => !needsLook(p) && p.kind !== "duplicate"),
      duplicates: all.filter((p) => !needsLook(p) && p.kind === "duplicate"),
    };
  }, [pending.data]);

  useEffect(() => {
    if (!pending.data) return;
    if (tab === "ready" && !groups.ready.length) setTab(groups.look.length ? "look" : groups.duplicates.length ? "duplicates" : series.data?.length ? "series" : "ready");
    // Only when the data arrives, not when someone picks a tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.data]);

  const apply = useMutation({
    mutationFn: (ids: number[]) => api<{ ok: number; failed: { id: number; error: string }[] }>("POST", "/proposals/apply", { ids, label: "Organized from Review" }),
    onSuccess: (res) => {
      if (res.failed.length) toast.error(`${res.failed.length} couldn't be done: ${res.failed[0].error}`);
      if (res.ok) toast.success(`Done: ${res.ok} book${res.ok === 1 ? "" : "s"}. You can undo this under Activity.`);
      setConfirm(null);
      qc.invalidateQueries();
    },
    onError: (err) => toast.error(err.message),
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: number; owners?: number[]; resolution?: string; author?: string; title?: string }) => api("PATCH", `/proposals/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
    onError: (err) => toast.error(err.message),
  });
  const skip = useMutation({
    mutationFn: (ids: number[]) => api("POST", "/proposals/skip", { ids }),
    onSuccess: () => qc.invalidateQueries(),
  });

  if (!pending.data || !people.data) return <PageSpinner />;
  const list = tab === "done" ? (done.data ?? []) : tab === "series" ? [] : groups[tab];
  const total = pending.data.length;
  const freed = groups.duplicates.reduce((n, p) => n + p.size, 0);
  // Everything that can go right now, duplicates after what they merge into.
  const goable = [...groups.ready, ...groups.duplicates];

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Review"
        description="What Shelvarr would like to do. Nothing moves until you say so, and everything can be undone."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => scan.mutate(undefined)} loading={!!status?.running || scan.isPending}>
              {!status?.running && <RefreshCw className="h-4 w-4" />} Scan
            </Button>
            {goable.length > 0 && (
              <Button size="sm" onClick={() => setConfirm(goable)}>
                <CheckCheck className="h-4 w-4" /> Do all {goable.length}
              </Button>
            )}
          </>
        }
      />
      {status?.running && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> {status.running}. Large libraries take a little while.
        </div>
      )}
      <div className="mb-4 overflow-x-auto">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "look", label: `Needs a look ${groups.look.length}` },
            { value: "ready", label: `Ready ${groups.ready.length}` },
            { value: "duplicates", label: `Duplicates ${groups.duplicates.length}` },
            { value: "series", label: `Series ${series.data?.length ?? 0}` },
            { value: "done", label: "Done" },
          ]}
        />
      </div>
      {tab === "duplicates" && groups.duplicates.length > 0 && (
        <p className="mb-3 text-sm text-muted-foreground">
          Byte-for-byte copies of a book, checked again before anything's removed. Merging frees <strong className="font-medium text-foreground">{formatBytes(freed)}</strong> once you empty the trash, and everyone keeps access.
        </p>
      )}
      {tab === "series" ? (
        <SeriesTab list={series.data ?? []} />
      ) : list.length === 0 ? (
        <EmptyState icon={<ListChecks className="h-5 w-5" />} title={total === 0 && tab !== "done" ? "All tidy" : "Nothing here"}>
          {total === 0 && tab !== "done" ? "Nothing's waiting. Scan to check again." : undefined}
        </EmptyState>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {list.map((p) => (
            <Row
              key={p.id}
              p={p}
              people={people.data!}
              done={tab === "done"}
              onEdit={() => setEditing(p)}
              onOwners={(owners) => update.mutate({ id: p.id, owners })}
              onResolve={(resolution) => update.mutate({ id: p.id, resolution })}
              onSuggest={() => p.suggestion && update.mutate({ id: p.id, author: p.suggestion.author, title: p.suggestion.title })}
              onApply={() => apply.mutate([p.id])}
              onSkip={() => skip.mutate([p.id])}
              busy={apply.isPending}
            />
          ))}
        </div>
      )}
      {editing && <EditModal p={editing} onClose={() => setEditing(null)} />}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={`Organize ${confirm.length} book${confirm.length === 1 ? "" : "s"}?`}
          description="Files move into Author/Book folders. You can undo this from Activity."
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>Not yet</Button>
              <Button onClick={() => apply.mutate(confirm.map((p) => p.id))} loading={apply.isPending}>Organize</Button>
            </>
          }
        >
          <ul className="space-y-1 pb-2 text-sm text-muted-foreground">
            <li>{confirm.filter((p) => p.kind !== "duplicate").length} moved to their own folders</li>
            {confirm.some((p) => p.kind === "duplicate") && <li>{confirm.filter((p) => p.kind === "duplicate").length} duplicates merged, to the trash ({formatBytes(freed)})</li>}
            {groups.look.length > 0 && <li>{groups.look.length} that need a look stay where they are</li>}
          </ul>
        </Modal>
      )}
    </div>
  );
}

const SOURCE: Record<SeriesSuggestion["source"], string> = {
  tags: "from the audio file's tags",
  metadata: "from the metadata file",
  title: "from the book's full title",
  online: "looked up online",
  you: "set by you",
};

function SeriesTab({ list }: { list: SeriesSuggestion[] }) {
  const qc = useQueryClient();
  const { status } = useEngine();
  const [editing, setEditing] = useState<SeriesSuggestion | null>(null);
  const opts = {
    onSuccess: () => qc.invalidateQueries(),
    onError: (err: Error) => toast.error(err.message),
  };
  const find = useMutation({ mutationFn: () => api("POST", "/series/find", {}), ...opts });
  const apply = useMutation({
    mutationFn: (rels: string[]) => api<{ ok: number }>("POST", "/series/apply", { rels }),
    onSuccess: (r) => {
      toast.success(`Set the series on ${r.ok} book${r.ok === 1 ? "" : "s"} in Audiobookshelf`);
      qc.invalidateQueries();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const skip = useMutation({ mutationFn: (rels: string[]) => api("POST", "/series/skip", { rels }), ...opts });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-2xl text-sm text-muted-foreground">Books Audiobookshelf doesn't have in a series yet. Series you've already set are never changed.</p>
        <Button variant="outline" size="sm" onClick={() => find.mutate()} loading={find.isPending || !!status?.running}><Search className="h-4 w-4" /> Find series</Button>
        {list.length > 0 && <Button size="sm" onClick={() => apply.mutate(list.map((x) => x.rel))} loading={apply.isPending}><CheckCheck className="h-4 w-4" /> Set all {list.length}</Button>}
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<Layers className="h-5 w-5" />} title="No series waiting">Click Find series to check your books, including a lookup online for any that don't say.</EmptyState>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {list.map((x) => (
            <div key={x.rel} className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{x.title}</span>
                  <span className="text-sm text-muted-foreground">{x.author}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{x.series}{x.sequence ? ` #${x.sequence}` : ""}</span> · {SOURCE[x.source]}
                </div>
              </div>
              <button onClick={() => setEditing(x)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={`Edit series for ${x.title}`}><Pencil className="h-4 w-4" /></button>
              <Button variant="ghost" size="sm" onClick={() => skip.mutate([x.rel])}>Leave</Button>
              <Button variant="outline" size="sm" onClick={() => apply.mutate([x.rel])} disabled={apply.isPending}>Set</Button>
            </div>
          ))}
        </div>
      )}
      {editing && <SeriesModal item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SeriesModal({ item, onClose }: { item: SeriesSuggestion; onClose: () => void }) {
  const qc = useQueryClient();
  const [series, setSeries] = useState(item.series);
  const [sequence, setSequence] = useState(item.sequence ?? "");
  const save = useMutation({
    mutationFn: () => api("PATCH", "/series", { rel: item.rel, series, sequence }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["series"] });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal open onClose={onClose} title={item.title} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!series.trim()}>Save</Button></>}>
      <div className="space-y-4 pb-2">
        <Field label="Series" htmlFor="s-name"><Input id="s-name" value={series} onChange={(e) => setSeries(e.target.value)} /></Field>
        <Field label="Book number" htmlFor="s-num"><Input id="s-num" value={sequence} onChange={(e) => setSequence(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function Row({ p, people, done, onEdit, onOwners, onResolve, onSuggest, onApply, onSkip, busy }: {
  p: Proposal;
  people: Person[];
  done: boolean;
  onEdit: () => void;
  onOwners: (owners: number[]) => void;
  onResolve: (r: string) => void;
  onSuggest: () => void;
  onApply: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  const from = p.scope === "incoming" ? `Downloads/${p.sourceDir || p.files[0]}` : p.sourceDir || p.files[0];
  const showSuggestion = !done && p.suggestion && (p.suggestion.title !== p.title || p.suggestion.author !== p.author);
  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{p.title ?? "Unknown title"}</span>
            <span className="text-sm text-muted-foreground">{p.author ?? "Unknown author"}</span>
            {p.kind === "duplicate" && <Badge tone="primary"><Copy className="h-3 w-3" /> Duplicate</Badge>}
            {p.kind === "conflict" && <Badge tone="warning"><Files className="h-3 w-3" /> Two versions</Badge>}
            {p.status === "failed" && <Badge tone="danger"><AlertTriangle className="h-3 w-3" /> Failed</Badge>}
            {p.status === "skipped" && <Badge>Left alone</Badge>}
            {p.confidence !== "high" && p.status !== "failed" && <Badge tone="warning">Not sure</Badge>}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="max-w-full truncate" title={from}>{from}</span>
            <ArrowRight className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium text-foreground/80">{p.kind === "duplicate" ? `merge into ${p.targetRel}` : p.dest ?? "?"}</span>
            <span>· {p.audioCount} file{p.audioCount === 1 ? "" : "s"} · {formatBytes(p.size)}</span>
          </div>
          {(p.confidence !== "high" || p.status === "failed") && <p className={cn("mt-1 text-xs", p.status === "failed" ? "text-destructive" : "text-warning")}>{p.error ?? p.why}</p>}
        </div>
        {!done && (
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={onEdit} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={`Edit ${p.title ?? "book"}`}><Pencil className="h-4 w-4" /></button>
            <Button variant="ghost" size="sm" onClick={onSkip}>Leave</Button>
            <Button variant="outline" size="sm" onClick={onApply} disabled={busy || !p.author || !p.title || (p.kind === "conflict" && !p.resolution)}>{p.kind === "duplicate" ? "Merge" : "Organize"}</Button>
          </div>
        )}
      </div>
      {showSuggestion && (
        <button onClick={onSuggest} className="flex items-center gap-1.5 rounded-lg bg-primary-soft/60 px-2.5 py-1.5 text-left text-xs hover:bg-primary-soft">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span>Looked up online: <strong className="font-medium">{p.suggestion!.title}</strong> by {p.suggestion!.author}. <span className="font-medium text-primary">Use this</span></span>
        </button>
      )}
      {p.kind === "conflict" && !done && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-xs">
          <span className="mr-1">A different {p.targetRel} is already there.</span>
          {([["keep_other", "Keep the other one"], ["keep_this", "Keep this one"], ["keep_both", "Keep both"]] as const).map(([value, label]) => (
            <button key={value} onClick={() => onResolve(value)} className={cn("rounded-full border px-2.5 py-0.5 font-medium", p.resolution === value ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}>{label}</button>
          ))}
        </div>
      )}
      {!done && people.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {people.map((person) => {
            const on = p.owners.includes(person.id);
            return (
              <button
                key={person.id}
                onClick={() => onOwners(on ? p.owners.filter((x) => x !== person.id) : [...p.owners, person.id])}
                aria-pressed={on}
                aria-label={`${on ? "Remove" : "Add"} ${person.name}`}
                title={`${on ? "Remove" : "Add"} ${person.name}`}
                className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold", on ? "text-white" : "border border-dashed opacity-60 hover:opacity-100")}
                style={on ? { backgroundColor: person.color } : { borderColor: person.color, color: person.color }}
              >
                {faceLabel(person, people)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EditModal({ p, onClose }: { p: Proposal; onClose: () => void }) {
  const qc = useQueryClient();
  const [author, setAuthor] = useState(p.author ?? "");
  const [title, setTitle] = useState(p.title ?? "");
  const [query, setQuery] = useState<{ title: string; author: string } | null>(null);
  const results = useQuery({
    queryKey: ["lookup", query],
    queryFn: () => get<{ title: string; author: string; narrator?: string; year?: string }[]>(`/lookup?${new URLSearchParams(query!)}`),
    enabled: !!query,
  });
  const save = useMutation({
    mutationFn: () => api("PATCH", `/proposals/${p.id}`, { author, title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposals"] });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="What is this book?"
      description={p.sourceDir || p.files[0]}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!author.trim() || !title.trim()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label="Author" htmlFor="b-author"><Input id="b-author" value={author} onChange={(e) => setAuthor(e.target.value)} /></Field>
        <Field label="Title" htmlFor="b-title" hint={author && title ? `Goes to ${author}/${title}` : undefined}><Input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Button variant="outline" size="sm" onClick={() => setQuery({ title, author })} disabled={!title.trim()}><Search className="h-4 w-4" /> Look up online</Button>
        {query && (
          <div className="divide-y rounded-xl border">
            {results.isLoading ? (
              <div className="flex justify-center py-4"><Spinner /></div>
            ) : !results.data?.length ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">Nothing found. This uses Audiobookshelf's search, so it needs to be connected.</p>
            ) : (
              results.data.map((r, i) => (
                <button key={i} onClick={() => { setAuthor(r.author); setTitle(r.title); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">
                  <span className="font-medium">{r.title}</span> <span className="text-muted-foreground">by {r.author}{r.year ? ` · ${r.year}` : ""}{r.narrator ? ` · read by ${r.narrator}` : ""}</span>
                </button>
              ))
            )}
          </div>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{p.fileCount} files</summary>
          <ul className="mt-1 space-y-0.5">{p.files.map((f) => <li key={f} className="truncate">{f}</li>)}</ul>
        </details>
      </div>
    </Modal>
  );
}
