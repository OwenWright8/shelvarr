import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, FolderInput, RefreshCw, ShieldCheck, Tag, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, formatBytes, get, type Activity, type Batch } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, Modal, PageSpinner, cn, timeAgo } from "@/components/ui";

const ICON: Record<Activity["kind"], { icon: React.ReactNode; className: string }> = {
  moved: { icon: <FolderInput className="h-3.5 w-3.5" />, className: "bg-primary-soft text-primary" },
  duplicate: { icon: <FolderInput className="h-3.5 w-3.5" />, className: "bg-primary-soft text-primary" },
  owner: { icon: <Tag className="h-3.5 w-3.5" />, className: "bg-primary-soft text-primary" },
  scan: { icon: <RefreshCw className="h-3.5 w-3.5" />, className: "bg-success/10 text-success" },
  access: { icon: <ShieldCheck className="h-3.5 w-3.5" />, className: "bg-accent/10 text-accent" },
  undo: { icon: <Undo2 className="h-3.5 w-3.5" />, className: "bg-muted text-muted-foreground" },
  error: { icon: <AlertCircle className="h-3.5 w-3.5" />, className: "bg-destructive/10 text-destructive" },
};

export function ActivityList({ entries, empty }: { entries: Activity[]; empty: string }) {
  if (!entries.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1">
      {entries.map((a) => {
        const style = ICON[a.kind] ?? ICON.scan;
        return (
          <li key={a.id} className="flex items-start gap-3 rounded-lg py-1.5">
            <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", style.className)}>{style.icon}</span>
            <span className={cn("min-w-0 flex-1 text-sm", a.kind === "error" && "text-destructive")}>{a.message}</span>
            <time className="shrink-0 pt-0.5 text-xs text-muted-foreground" title={new Date(a.at).toLocaleString()}>
              {timeAgo(a.at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

export default function ActivityPage() {
  const qc = useQueryClient();
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => get<Activity[]>("/activity"), refetchInterval: 30_000 });
  const batches = useQuery({ queryKey: ["batches"], queryFn: () => get<Batch[]>("/batches") });
  const trash = useQuery({ queryKey: ["trash"], queryFn: () => get<{ size: number; path: string }>("/trash") });
  const [confirm, setConfirm] = useState(false);
  const undo = useMutation({
    mutationFn: (id: number) => api<{ problems: string[] }>("POST", `/batches/${id}/undo`, {}),
    onSuccess: (res) => {
      if (res.problems.length) toast.error(`Undone, with problems: ${res.problems[0]}`);
      else toast.success("Undone: everything's back where it was");
      qc.invalidateQueries();
    },
    onError: (err) => toast.error(err.message),
  });
  const empty = useMutation({
    mutationFn: () => api<{ freed: number }>("POST", "/trash/empty", {}),
    onSuccess: (res) => {
      toast.success(`Freed ${formatBytes(res.freed)}`);
      setConfirm(false);
      qc.invalidateQueries();
    },
    onError: (err) => toast.error(err.message),
  });
  if (!activity.data || !batches.data) return <PageSpinner />;
  const size = trash.data?.size ?? 0;

  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader title="Activity" description="What Shelvarr has done, a way to undo it, and the trash." />
      <Card>
        <CardHeader icon={<Trash2 className="h-5 w-5" />} title="Trash" description={size ? `${formatBytes(size)} of duplicates and replaced copies. Nothing's really gone until you empty it.` : "Empty. Duplicates land here before they're gone for good."} action={size > 0 ? <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>Empty trash</Button> : undefined} />
        <CardBody className="pt-3 text-xs text-muted-foreground sm:pt-3">{trash.data?.path}</CardBody>
      </Card>
      {batches.data.length > 0 && (
        <Card>
          <CardHeader icon={<Undo2 className="h-5 w-5" />} title="Undo" description="Each change can be reversed, as long as the trash it used hasn't been emptied." />
          <CardBody>
            <ul className="divide-y">
              {batches.data.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{b.label}</span>
                    <span className="text-muted-foreground"> · {b.books} book{b.books === 1 ? "" : "s"} · {timeAgo(b.at)}</span>
                  </span>
                  {b.undone ? (
                    <span className="text-xs text-muted-foreground">Undone</span>
                  ) : b.canUndo ? (
                    <Button variant="ghost" size="sm" onClick={() => undo.mutate(b.id)} loading={undo.isPending && undo.variables === b.id}>
                      Undo
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Trash emptied</span>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardBody>
          <ActivityList entries={activity.data} empty="Nothing has happened yet." />
        </CardBody>
      </Card>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Empty the trash?"
        description={`This permanently deletes ${formatBytes(size)}. The changes that put those files there can't be undone afterwards.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>Keep them</Button>
            <Button variant="danger" onClick={() => empty.mutate()} loading={empty.isPending}>Delete permanently</Button>
          </>
        }
      >
        <span />
      </Modal>
    </div>
  );
}
