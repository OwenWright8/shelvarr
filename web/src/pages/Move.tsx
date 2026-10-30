import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Combine } from "lucide-react";
import { toast } from "sonner";
import { api, get, type MigrateState } from "@/lib/api";
import { PageHeader, useEngine } from "@/components/Layout";
import { Button, Card, EmptyState, PageSpinner, cn } from "@/components/ui";

/** The one-time move from a library per person to one shared library. */
export default function MovePage() {
  const qc = useQueryClient();
  const { status, scan } = useEngine();
  const state = useQuery({ queryKey: ["migrate"], queryFn: () => get<MigrateState>("/migrate") });
  const opts = (done: string) => ({
    onSuccess: () => {
      toast.success(done);
      qc.invalidateQueries();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const snapshot = useMutation({ mutationFn: () => api("POST", "/migrate/snapshot", {}), ...opts("Listening progress saved") });
  const library = useMutation({ mutationFn: () => api("POST", "/migrate/library", { name: "Audiobooks" }), ...opts("Shared library ready") });
  const restore = useMutation({
    mutationFn: () => api<{ restored: number; waiting: number; problems: string[] }>("POST", "/migrate/restore", {}),
    onSuccess: (r) => {
      if (r.problems.length) toast.error(r.problems[0]);
      else toast.success(`Restored ${r.restored} book${r.restored === 1 ? "" : "s"}${r.waiting ? `. ${r.waiting} couldn't be matched to a book in the shared library yet: if Audiobookshelf is still scanning, try again in a minute` : ""}`);
      qc.invalidateQueries();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  if (state.isError) return <EmptyState icon={<Combine className="h-5 w-5" />} title="Can't reach Audiobookshelf">{state.error.message}</EmptyState>;
  if (!state.data) return <PageSpinner />;
  const s = state.data;
  const organized = s.applied > 0 && s.pending === 0;

  return (
    <div className="animate-fade-in">
      <PageHeader title="One library" description="Move from a library per person to one shared library with no duplicate copies. Do these once, in order. Everyone's listening progress comes along." />
      <div className="space-y-3">
        <Step n={1} done={s.snapshot.entries > 0} title="Save everyone's listening progress" text="Do this first: Audiobookshelf ties progress to the old library's items, so it has to be saved before they move.">
          <Button variant={s.snapshot.entries ? "outline" : "primary"} size="sm" onClick={() => snapshot.mutate()} loading={snapshot.isPending}>{s.snapshot.entries ? `Saved ${s.snapshot.entries} ${s.snapshot.entries === 1 ? "entry" : "entries"}. Save again` : "Save progress"}</Button>
        </Step>
        <Step n={2} done={organized} title="Organize the books" text={s.pending ? `${s.pending} suggestions are waiting. Approve them, and sort out any that need a look.` : "Scan the old folders, then approve the moves. Duplicates merge into one copy and each person keeps access."}>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => scan.mutate("library")} loading={!!status?.running}>Scan</Button>
            <Link to="/review"><Button size="sm" variant={s.pending ? "primary" : "outline"}>Open Review</Button></Link>
          </div>
        </Step>
        <Step n={3} done={!!s.sharedLibraryId} title="Create the shared library" text={`Adds a library in Audiobookshelf at ${s.sharedPath}. Audiobookshelf has to see that folder at that path. Your old libraries stay for now.`}>
          <Button variant={s.sharedLibraryId ? "outline" : "primary"} size="sm" onClick={() => library.mutate()} loading={library.isPending}>{s.sharedLibraryId ? "Done. Set up again" : "Create it"}</Button>
        </Step>
        <Step n={4} done={s.snapshot.entries > 0 && s.snapshot.restored > 0} title="Bring progress back, and tag the books" text={`Puts each person's progress and bookmarks on the new items.${s.snapshot.entries ? ` ${s.snapshot.restored} of ${s.snapshot.entries} done (where two copies existed, the most recent wins).` : ""} Needs Audiobookshelf 2.26 or newer.`}>
          <Button size="sm" variant="outline" onClick={() => restore.mutate()} loading={restore.isPending} disabled={!s.sharedLibraryId}>Restore</Button>
        </Step>
        <Step n={5} title="Limit each person to their shelf" text="Without this, everyone sees every book in the shared library.">
          <Link to="/access"><Button size="sm" variant="outline">Open Access</Button></Link>
        </Step>
        <Step n={6} title="Check it, then remove the old libraries" text="Open Audiobookshelf as each person and check their shelf and progress. Then, in Audiobookshelf, delete the old per-person libraries (Settings → Libraries). That removes the library entry, and the old folders are empty of books by then. Finally, empty the trash here under Activity to free the space." />
      </div>
    </div>
  );
}

function Step({ n, done, title, text, children }: { n: number; done?: boolean; title: string; text: string; children?: React.ReactNode }) {
  return (
    <Card className="flex gap-4 p-4 sm:p-5">
      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold", done ? "bg-success text-white" : "bg-muted text-muted-foreground")}>{done ? <Check className="h-4 w-4" /> : n}</span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </Card>
  );
}
