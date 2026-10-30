import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity as ActivityIcon,
  Combine,
  ListChecks,
  LayoutDashboard,
  Library as LibraryIcon,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, get, type EngineStatus, type Overview } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { cn, timeAgo } from "./ui";
import { UpdateNotice, UpdatePrompt } from "./UpdatePrompt";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/review", label: "Review", icon: ListChecks, badge: "review" as const },
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/move", label: "One library", icon: Combine },
  { to: "/access", label: "Access", icon: ShieldCheck },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];
const MOBILE_NAV = ["/", "/review", "/library", "/activity", "/settings"];

export function Logo({ className }: { className?: string }) {
  return <img src="/icon.svg" alt="" className={cn("h-8 w-8 rounded-[9px]", className)} />;
}

export function useOverview() {
  return useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/overview"), refetchInterval: 30_000 });
}

/** What the server is busy with. Refreshes everything when it finishes. */
export function useEngine() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => get<EngineStatus>("/status"),
    refetchInterval: (q) => (q.state.data?.running ? 1000 : 20_000),
  });
  const running = !!status.data?.running;
  const [was, setWas] = useState(false);
  useEffect(() => {
    if (was && !running) qc.invalidateQueries();
    setWas(running);
  }, [running, was, qc]);
  const scan = useMutation({
    mutationFn: (scope?: "library" | "incoming") => api("POST", "/scan", { scope }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });
  return { status: status.data, scan };
}

export function ScanButton({ compact }: { compact?: boolean }) {
  const { status, scan } = useEngine();
  const busy = !!status?.running || scan.isPending;
  return (
    <button
      onClick={() => scan.mutate(undefined)}
      disabled={busy}
      className={cn(
        "group flex items-center gap-2.5 rounded-lg text-left text-[13px] transition-colors hover:bg-muted disabled:opacity-80",
        compact ? "p-2" : "w-full px-3 py-2",
      )}
      title="Look for books to tidy, now"
    >
      <RefreshCw className={cn("h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground", busy && "animate-spin text-primary")} />
      {!compact && (
        <span className="min-w-0">
          <span className="block font-medium">{status?.running ? `${status.running}…` : "Scan now"}</span>
          <span className={cn("block truncate text-xs", status?.lastError ? "text-destructive" : "text-muted-foreground")}>
            {status?.lastError ? "Last run had problems" : `Last scan ${timeAgo(status?.lastScanAt)}`}
          </span>
        </span>
      )}
    </button>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button
      onClick={() => setTheme(next)}
      className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function Layout({ onSignOut }: { onSignOut: () => void }) {
  const overview = useOverview();
  const location = useLocation();
  const counts = { review: overview.data?.totals.toReview ?? 0 };
  useEffect(() => window.scrollTo(0, 0), [location.pathname]);

  return (
    <div className="min-h-screen">
      <UpdatePrompt />
      <div className="flex">
        {/* Sidebar (desktop) */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/60 px-3 py-4 lg:flex">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">Shelvarr</span>
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isActive ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="h-[18px] w-[18px]" />
                <span className="flex-1">{item.label}</span>
                {item.badge && counts[item.badge] > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-px text-[11px] font-semibold text-primary-foreground">{counts[item.badge]}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-1 border-t pt-3">
            <UpdateNotice />
            <ScanButton />
            <div className="flex items-center justify-between px-1">
              <ThemeButton />
              <button
                onClick={onSignOut}
                className="flex items-center gap-1.5 rounded-lg p-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* Top bar (mobile) */}
          <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/85 px-4 py-2.5 backdrop-blur lg:hidden">
            <div className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold tracking-tight">Shelvarr</span>
            </div>
            <div className="flex items-center">
              <ScanButton compact />
              <ThemeButton />
            </div>
          </header>

          <main className="mx-auto max-w-6xl px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-16 lg:pt-9">
            <UpdateNotice className="mb-4 lg:hidden" />
            <Outlet />
          </main>

          {/* Bottom tabs (mobile) */}
          <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
            {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive ? "text-primary" : "text-muted-foreground")
                }
              >
                <item.icon className="h-5 w-5" />
                {item.label}
                {item.badge && counts[item.badge] > 0 && <span className="absolute right-[calc(50%-18px)] top-1.5 h-2 w-2 rounded-full bg-primary" />}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground sm:text-[15px]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
