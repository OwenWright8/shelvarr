// "A new version is out" prompt. The server checks GitHub (never the
// browser); when it reports a newer release, this shows the release notes
// and how to update, once per version. "Later" asks again in a few days;
// "Skip this version" stays quiet until the next one.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle, Check, Copy } from "lucide-react";
import { get, type About } from "@/lib/api";
import { Button, Modal, cn, timeAgo } from "./ui";

const SKIP_KEY = "shelvarr-update-skip";
const LATER_KEY = "shelvarr-update-later";
const LATER_DAYS = 3;
const OPEN_EVENT = "shelvarr:show-update";
const UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export function useAbout() {
  return useQuery({ queryKey: ["about"], queryFn: () => get<About>("/about"), staleTime: 3_600_000, refetchInterval: 6 * 3_600_000 });
}

/** Opens the prompt from anywhere (the sidebar notice, Settings → Check for updates). */
export function showUpdatePrompt() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; it'll just ask again next time.
  }
}

/** The update the person hasn't skipped, if there is one. */
function useOffer() {
  const about = useAbout();
  const latest = about.data?.updateAvailable ? about.data.update.latest : null;
  const [skipped, setSkipped] = useState(() => read(SKIP_KEY));
  return {
    about: about.data,
    latest: latest && latest !== skipped ? latest : null,
    skip: (v: string) => {
      write(SKIP_KEY, v);
      setSkipped(v);
    },
  };
}

export function UpdatePrompt() {
  const { about, latest, skip } = useOffer();
  const [open, setOpen] = useState(false);

  // Once per version, unless they said "later" recently.
  useEffect(() => {
    if (!latest) return;
    try {
      const later = JSON.parse(read(LATER_KEY) ?? "null") as { version: string; until: number } | null;
      if (later?.version === latest && Date.now() < later.until) return;
    } catch {
      // Unreadable: just ask.
    }
    setOpen(true);
  }, [latest]);

  useEffect(() => {
    const onShow = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onShow);
    return () => window.removeEventListener(OPEN_EVENT, onShow);
  }, []);

  const version = about?.update.latest;
  if (!open || !about?.updateAvailable || !version) return null;

  const later = () => {
    write(LATER_KEY, JSON.stringify({ version, until: Date.now() + LATER_DAYS * 86_400_000 }));
    setOpen(false);
  };

  return (
    <Modal
      open
      onClose={later}
      wide
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle className="h-5 w-5 text-primary" /> Shelvarr {version} is out
        </span>
      }
      description={
        <>
          You're on {about.version}
          {about.update.publishedAt && <> · released {timeAgo(about.update.publishedAt)}</>}
        </>
      }
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              skip(version);
              setOpen(false);
            }}
          >
            Skip this version
          </Button>
          <Button variant="outline" onClick={later}>
            Remind me later
          </Button>
          {about.update.url && (
            <a href={about.update.url} target="_blank" rel="noreferrer">
              <Button className="w-full">Full release notes</Button>
            </a>
          )}
        </>
      }
    >
      <div className="space-y-5 pb-2">
        {about.update.notes ? <ReleaseNotes text={about.update.notes} /> : <p className="text-sm text-muted-foreground">See the release notes on GitHub for what changed.</p>}
        <div className="rounded-xl border bg-muted/40 p-4">
          <h3 className="text-sm font-semibold">How to update</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Your people, owners and settings are kept; it takes a few seconds. In <strong className="font-medium text-foreground">Dockge</strong> or{" "}
            <strong className="font-medium text-foreground">Portainer</strong>, open the Shelvarr stack and pull/update it. With Docker Compose, in Shelvarr's folder:
          </p>
          <CopyCommand text={UPDATE_COMMAND} />
        </div>
      </div>
    </Modal>
  );
}

/** A small reminder in the sidebar while an update is waiting (and not skipped). */
export function UpdateNotice({ className }: { className?: string }) {
  const { latest } = useOffer();
  if (!latest) return null;
  return (
    <button
      onClick={showUpdatePrompt}
      className={cn("flex w-full items-center gap-2.5 rounded-lg bg-primary-soft px-3 py-2 text-left text-[13px] font-medium text-primary hover:brightness-95", className)}
    >
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <span className="truncate">Update available: {latest}</span>
    </button>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border bg-card py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px]">{text}</code>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Copy the command"
      >
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Just enough Markdown for GitHub's release notes: headings and bullet lists,
 * with links and emphasis shown as plain text. Never rendered as HTML.
 */
function ReleaseNotes({ text }: { text: string }) {
  const inline = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
      .replace(/\s+by @[\w-]+ in https?:\/\/\S+$/, "") // "… by @someone in <PR url>"
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
  const blocks: { kind: "h" | "p" | "ul"; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\*\*Full Changelog\*\*/i.test(line)) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (heading) blocks.push({ kind: "h", lines: [inline(heading[1])] });
    else if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "ul") last.lines.push(inline(bullet[1]));
      else blocks.push({ kind: "ul", lines: [inline(bullet[1])] });
    } else blocks.push({ kind: "p", lines: [inline(line)] });
  }
  if (!blocks.length) return null;
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto pr-1 text-sm">
      {blocks.map((b, i) =>
        b.kind === "h" ? (
          <h3 key={i} className="pt-1 font-semibold">
            {b.lines[0]}
          </h3>
        ) : b.kind === "ul" ? (
          <ul key={i} className="list-disc space-y-1 pl-5 text-muted-foreground">
            {b.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          <p key={i} className="text-muted-foreground">
            {b.lines[0]}
          </p>
        ),
      )}
    </div>
  );
}
