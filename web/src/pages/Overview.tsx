import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, BookOpen, Combine, EyeOff, ListChecks, Tags, UserX, Users } from "lucide-react";
import { api, formatBytes, get } from "@/lib/api";
import { PageHeader, useOverview } from "@/components/Layout";
import { Avatar } from "@/components/people";
import { ActivityList } from "@/pages/Activity";
import { Card, CardBody, CardHeader, PageSpinner, cn, timeAgo } from "@/components/ui";

export default function OverviewPage() {
  const overview = useOverview();
  if (!overview.data) return <PageSpinner />;
  const { totals, people, activity, status, connections } = overview.data;
  const max = Math.max(1, ...people.map((p) => p.count));
  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Overview"
        description={
          <>
            {totals.books} books by {totals.authors} authors · {formatBytes(totals.size)}
            {status.lastScanAt && <> · checked {timeAgo(status.lastScanAt)}</>}
          </>
        }
      />
      <AccessReminder />
      {status.lastError && (
        <Banner icon={<AlertTriangle className="h-4 w-4" />} to="/activity" action="See activity" danger>
          The last run had a problem: {status.lastError}
        </Banner>
      )}
      {totals.books === 0 && totals.toReview === 0 && (
        <Banner icon={<Combine className="h-4 w-4" />} to="/move" action="Get started">
          Your library hasn't been organized yet. Start with the step-by-step move to one library.
        </Banner>
      )}
      {!connections.library && totals.books > 0 && (
        <Banner icon={<Combine className="h-4 w-4" />} to="/move" action="Finish the move">
          Books are organized, but no shared Audiobookshelf library is set yet.
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Tile to="/review" icon={<ListChecks className="h-4 w-4" />} label="To review" value={totals.toReview} hint={totals.duplicateSize ? `${formatBytes(totals.duplicateSize)} of duplicates to free` : "Waiting for your OK"} highlight={totals.toReview > 0} />
        <Tile to="/library" icon={<BookOpen className="h-4 w-4" />} label="Books" value={totals.books} hint={formatBytes(totals.size)} />
        <Tile to="/library?filter=shared" icon={<Tags className="h-4 w-4" />} label="Shared" value={totals.shared} hint="One copy, 2+ people" />
        <Tile to="/library?filter=unowned" icon={<UserX className="h-4 w-4" />} label="Nobody's" value={totals.unowned} hint="Hidden from anyone limited" highlight={totals.unowned > 0} />
      </div>
      <div className="mt-4 grid gap-4 sm:mt-6 sm:gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<Users className="h-5 w-5" />} title="People" action={<Link to="/settings#people" className="text-sm font-medium text-primary hover:underline">Manage</Link>} />
          <CardBody>
            {people.length === 0 ? (
              <p className="text-sm text-muted-foreground">No people yet. <Link to="/settings#people" className="font-medium text-primary hover:underline">Add someone</Link>.</p>
            ) : (
              <ul className="space-y-4">
                {people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3">
                    <Avatar person={p} />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between text-sm">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-muted-foreground">{p.count} · {p.onlyCount} only theirs</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${(p.count / max) * 100}%`, backgroundColor: p.color }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent activity" action={<Link to="/activity" className="text-sm font-medium text-primary hover:underline">All activity</Link>} />
          <CardBody>
            <ActivityList entries={activity} empty="Nothing has happened yet." />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** Tags hide nothing until a person's Audiobookshelf account is limited to theirs. */
function AccessReminder() {
  const qc = useQueryClient();
  const reminders = useQuery({ queryKey: ["access-reminders"], queryFn: () => get<{ userId: string; personName: string }[]>("/access/reminders"), staleTime: 60_000 });
  const dismiss = useMutation({
    mutationFn: (userIds: string[]) => api("POST", "/access/reminders/dismiss", { userIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access-reminders"] }),
  });
  const list = reminders.data ?? [];
  if (!list.length) return null;
  const names = list.map((r) => r.personName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <span className="flex flex-1 items-start gap-2">
        <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span><strong className="font-semibold">{who}</strong> can see every book in a shared library. Tags only hide things once {names.length === 1 ? "their account is" : "their accounts are"} limited to their own.</span>
      </span>
      <div className="flex shrink-0 items-center gap-4">
        <button onClick={() => dismiss.mutate(list.map((r) => r.userId))} className="text-muted-foreground hover:text-foreground">They should see everything</button>
        <Link to="/access" className="font-medium text-primary hover:underline">Set what they see →</Link>
      </div>
    </div>
  );
}

function Banner({ icon, children, to, action, danger }: { icon: React.ReactNode; children: React.ReactNode; to: string; action: string; danger?: boolean }) {
  return (
    <div className={cn("mb-4 flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center", danger ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-primary/20 bg-primary-soft/50")}>
      <span className="flex flex-1 items-start gap-2"><span className="mt-0.5">{icon}</span>{children}</span>
      <Link to={to} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{action} <ArrowRight className="h-3.5 w-3.5" /></Link>
    </div>
  );
}

function Tile({ to, icon, label, value, hint, highlight }: { to: string; icon: React.ReactNode; label: string; value: number; hint: string; highlight?: boolean }) {
  return (
    <Link to={to} className={cn("rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5", highlight && "border-primary/30 bg-primary-soft/40")}>
      <div className={cn("flex items-center gap-2 text-[13px] font-medium", highlight ? "text-primary" : "text-muted-foreground")}>{icon}{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </Link>
  );
}
