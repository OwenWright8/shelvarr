import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, get, type AccessUser, type Person, type SettingsData } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Avatar, usePeople } from "@/components/people";
import { Badge, Button, Card, EmptyState, Modal, PageSpinner, cn } from "@/components/ui";

export default function AccessPage() {
  const access = useQuery({ queryKey: ["access"], queryFn: () => get<{ users: AccessUser[] }>("/access") });
  const people = usePeople();
  const [editing, setEditing] = useState<AccessUser | null>(null);
  if (access.isError) return <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="Can't reach Audiobookshelf">{access.error.message}</EmptyState>;
  if (!access.data || !people.data) return <PageSpinner />;
  return (
    <div className="animate-fade-in">
      <PageHeader title="Access" description="Audiobookshelf can limit a user to books with certain tags. Set each person to their own tag, and shared books show up for everyone tagged on them." />
      {access.data.users.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="Connect Audiobookshelf first" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {access.data.users.map((u) => {
            const person = people.data!.find((p) => p.id === u.personId);
            const limited = u.allowedTags.length > 0;
            return (
              <Card key={u.id} className="flex flex-col p-5">
                <div className="flex items-start gap-3">
                  {person ? <Avatar person={person} size="lg" /> : <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">{u.name[0]?.toUpperCase()}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><h2 className="font-semibold">{u.name}</h2>{u.isAdmin && <Badge>Admin</Badge>}</div>
                    <p className="text-sm text-muted-foreground">{person ? `Linked to ${person.name}` : "Not linked to a person"}</p>
                  </div>
                  {limited ? <EyeOff className="h-5 w-5 text-primary" /> : <Eye className="h-5 w-5 text-muted-foreground" />}
                </div>
                <div className="mt-4 flex-1 rounded-lg bg-muted/60 p-3 text-sm">
                  {limited ? <>Sees books tagged {u.allowedTags.map((t, i) => <span key={t}>{i > 0 && " or "}<code className="rounded bg-card px-1.5 py-0.5 text-xs">{t}</code></span>)}</> : <>Sees every book it has access to{person && !u.isAdmin && u.meantToSeeAll && <RemindAgain userId={u.id} />}</>}
                </div>
                <Button variant="outline" size="sm" className="mt-3 self-start" onClick={() => setEditing(u)}>Change</Button>
              </Card>
            );
          })}
        </div>
      )}
      {editing && <Edit user={editing} people={people.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Edit({ user, people, onClose }: { user: AccessUser; people: Person[]; onClose: () => void }) {
  const qc = useQueryClient();
  const linked = people.find((p) => p.id === user.personId);
  const [limit, setLimit] = useState(user.allowedTags.length > 0 || !!linked);
  const [tags, setTags] = useState<string[]>(user.allowedTags.length ? user.allowedTags : linked ? [linked.tag] : []);
  const save = useMutation({
    mutationFn: () => api("POST", `/access/${user.id}`, { allowedTags: limit ? tags : [] }),
    onSuccess: () => {
      toast.success("Saved to Audiobookshelf");
      qc.invalidateQueries({ queryKey: ["access"] });
      qc.invalidateQueries({ queryKey: ["access-reminders"] });
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal open onClose={onClose} title={`What can ${user.name} see?`} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={limit && !tags.length}>Save to Audiobookshelf</Button></>}>
      <div className="space-y-2 pb-2">
        {[{ v: false, l: "Every book" }, { v: true, l: "Only books tagged for…" }].map((o) => (
          <button key={String(o.v)} onClick={() => setLimit(o.v)} className={cn("block w-full rounded-xl border px-3 py-2.5 text-left text-sm font-medium", limit === o.v ? "border-primary bg-primary-soft/50" : "hover:bg-muted")}>{o.l}</button>
        ))}
        {limit && (
          <div className="flex flex-wrap gap-2 pt-2">
            {people.map((p) => {
              const on = tags.includes(p.tag);
              return (
                <button key={p.id} onClick={() => setTags(on ? tags.filter((t) => t !== p.tag) : [...tags, p.tag])} aria-pressed={on} className={cn("inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] font-medium", !on && "opacity-60")} style={on ? { backgroundColor: `${p.color}1f`, borderColor: `${p.color}66`, color: p.color } : undefined}>
                  <Avatar person={p} size="sm" /> {p.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

function RemindAgain({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
  const undo = useMutation({
    mutationFn: () => api("PUT", "/settings", { accessReminderDismissed: (settings.data?.accessReminderDismissed ?? []).filter((id) => id !== userId) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  return <span className="text-muted-foreground"> · on purpose. <button onClick={() => undo.mutate()} className="font-medium text-primary hover:underline">Remind me again</button></span>;
}
