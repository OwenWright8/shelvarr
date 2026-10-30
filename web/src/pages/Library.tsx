import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CheckSquare, Minus, Pencil, Plus, Search, Square, X } from "lucide-react";
import { toast } from "sonner";
import { api, formatBytes, get, type Book, type Person } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Avatar, Cover, faceLabel, usePeople } from "@/components/people";
import { Button, EmptyState, Field, Input, Modal, PageSpinner, cn } from "@/components/ui";

export default function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") ?? "all";
  const [q, setQ] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<Book | null>(null);
  const people = usePeople();
  const books = useQuery({ queryKey: ["books"], queryFn: () => get<Book[]>("/books") });
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: (body: { rels: string[]; add?: number[]; remove?: number[] }) => api("POST", "/books/owners", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["books"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (books.data ?? []).filter((b) => {
      if (term && !`${b.title} ${b.author}`.toLowerCase().includes(term)) return false;
      if (filter === "shared") return b.owners.length > 1;
      if (filter === "unowned") return b.owners.length === 0;
      if (filter.startsWith("person:")) return b.owners.includes(Number(filter.slice(7)));
      return true;
    });
  }, [books.data, q, filter]);

  // Grouped by author, like the folders on disk.
  const byAuthor = useMemo(() => {
    const map = new Map<string, Book[]>();
    for (const b of shown) map.set(b.author, [...(map.get(b.author) ?? []), b]);
    return [...map.entries()];
  }, [shown]);

  if (!books.data || !people.data) return <PageSpinner />;
  const setFilter = (f: string) => setParams(f === "all" ? {} : { filter: f }, { replace: true });
  const filters = [
    { value: "all", label: "All" },
    { value: "shared", label: "Shared" },
    { value: "unowned", label: "Nobody's" },
    ...people.data.map((p) => ({ value: `person:${p.id}`, label: p.name })),
  ];
  const toggle = (rel: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Library"
        description="Your tidy books. Click someone's initial under a book to add it to, or take it off, their shelf."
        actions={
          <Button variant={selecting ? "secondary" : "outline"} size="sm" onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
            {selecting ? <X className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />} {selecting ? "Done" : "Select"}
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        {filters.map((f) => (
          <button key={f.value} onClick={() => setFilter(f.value)} className={cn("rounded-full border px-3 py-1.5 text-[13px] font-medium", filter === f.value ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}>{f.label}</button>
        ))}
      </div>
      <div className="relative mb-5">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles and authors" className="pl-9" type="search" />
      </div>
      {byAuthor.length === 0 ? (
        <EmptyState icon={<BookOpen className="h-5 w-5" />} title="No books here">Organized books show up here. Start from Review.</EmptyState>
      ) : (
        <div className="space-y-6">
          {byAuthor.map(([author, list]) => (
            <section key={author}>
              <h2 className="mb-2 text-sm font-semibold">{author} <span className="font-normal text-muted-foreground">{list.length}</span></h2>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-7">
                {list.map((b) => (
                  <BookCard
                    key={b.rel}
                    b={b}
                    people={people.data!}
                    selecting={selecting}
                    selected={selected.has(b.rel)}
                    onSelect={() => toggle(b.rel)}
                    onRename={() => setRenaming(b)}
                    onToggle={(p) => change.mutate({ rels: [b.rel], ...(b.owners.includes(p.id) ? { remove: [p.id] } : { add: [p.id] }) })}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {renaming && <RenameModal book={renaming} onClose={() => setRenaming(null)} />}
      {selected.size > 0 && (
        <div className="fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-2xl border bg-card p-3 shadow-lg lg:bottom-6">
          <span className="mr-auto text-sm font-semibold">{selected.size} selected</span>
          {people.data.map((p) => (
            <span key={p.id} className="inline-flex overflow-hidden rounded-lg border">
              <button onClick={() => change.mutate({ rels: [...selected], add: [p.id] })} className="flex items-center gap-1 py-1 pl-1.5 pr-2 text-[13px] hover:bg-muted" title={`Add ${p.name}`}><Avatar person={p} size="xs" /><Plus className="h-3 w-3" /></button>
              <button onClick={() => change.mutate({ rels: [...selected], remove: [p.id] })} className="border-l px-1.5 hover:bg-muted" aria-label={`Remove ${p.name}`}><Minus className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RenameModal({ book, onClose }: { book: Book; onClose: () => void }) {
  const qc = useQueryClient();
  const [author, setAuthor] = useState(book.author);
  const [title, setTitle] = useState(book.title);
  // "Diary of a Wimpy Kid - Big Shot": offer the part after the series name.
  const shorter = book.title.includes(" - ") ? book.title.split(" - ").pop()! : null;
  const save = useMutation({
    mutationFn: () => api("POST", "/books/rename", { rel: book.rel, author, title }),
    onSuccess: () => {
      toast.success("Renamed. You can undo this under Activity.");
      qc.invalidateQueries();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename this book"
      description="Renames its folder. Audiobookshelf keeps it as the same book, with its listening progress."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!author.trim() || !title.trim()}>Rename</Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        <Field label="Author" htmlFor="r-author"><Input id="r-author" value={author} onChange={(e) => setAuthor(e.target.value)} /></Field>
        <Field label="Title" htmlFor="r-title" hint={`Goes to ${author}/${title}`}><Input id="r-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        {shorter && shorter !== title && (
          <button type="button" onClick={() => setTitle(shorter)} className="rounded-full border px-3 py-1 text-[13px] font-medium hover:bg-muted">Use “{shorter}”</button>
        )}
      </div>
    </Modal>
  );
}

function BookCard({ b, people, selecting, selected, onSelect, onRename, onToggle }: { b: Book; people: Person[]; selecting: boolean; selected: boolean; onSelect: () => void; onRename: () => void; onToggle: (p: Person) => void }) {
  return (
    <div className={cn("relative overflow-hidden rounded-xl border bg-card shadow-sm", selected && "ring-2 ring-primary")}>
      <button onClick={selecting ? onSelect : undefined} className={cn("block w-full", !selecting && "cursor-default")} tabIndex={selecting ? 0 : -1}>
        <Cover itemId={b.itemId} title={b.title} className="aspect-square w-full" />
      </button>
      {selecting && <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/50 p-0.5 text-white">{selected ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}</span>}
      <div className="space-y-1.5 p-2">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium" title={b.title}>{b.title}</div>
          <button onClick={onRename} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Rename ${b.title}`}><Pencil className="h-3 w-3" /></button>
        </div>
        <div className="text-[11px] text-muted-foreground">{formatBytes(b.size)}{b.owners.length === 0 && " · nobody's"}</div>
        <div className="flex flex-wrap gap-1">
          {people.map((p) => {
            const on = b.owners.includes(p.id);
            return (
              <button key={p.id} onClick={() => onToggle(p)} aria-pressed={on} aria-label={`${on ? "Remove" : "Add"} ${p.name}`} title={`${on ? "Remove" : "Add"} ${p.name}`}
                className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold", on ? "text-white" : "border border-dashed opacity-60 hover:opacity-100")}
                style={on ? { backgroundColor: p.color } : { borderColor: p.color, color: p.color }}>
                {faceLabel(p, people)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
