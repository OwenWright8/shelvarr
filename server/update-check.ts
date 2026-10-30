// The update reminder. Every 6 hours the server asks GitHub for the latest
// release (one anonymous GET of a public URL; nothing about the instance or
// its users is sent) and the app compares it with the version it is running.
// Browsers never contact GitHub themselves. UPDATE_CHECK=off turns it off.

export interface UpdateInfo {
  enabled: boolean;
  latest: string | null;
  url: string | null;
  /** The release's notes (Markdown, trimmed), shown in the update prompt. */
  notes: string | null;
  publishedAt: string | null;
  checkedAt: number | null;
}

const SIX_HOURS = 6 * 3_600_000;
const MAX_NOTES = 6000;

export class UpdateChecker {
  info: UpdateInfo;
  repo: string;
  apiBase: string;
  private timer: NodeJS.Timeout | null = null;
  private lastManual = 0;

  constructor(enabled: boolean, repo: string, apiBase = "https://api.github.com") {
    this.repo = repo;
    this.apiBase = apiBase;
    this.info = { enabled, latest: null, url: null, notes: null, publishedAt: null, checkedAt: null };
  }

  start() {
    if (!this.info.enabled) return;
    const run = () => this.check().catch(() => {});
    setTimeout(run, 30_000).unref();
    this.timer = setInterval(run, SIX_HOURS);
    this.timer.unref();
  }

  /** "Check now" from Settings: at most once a minute, so it can't hammer GitHub. */
  async checkNow(): Promise<boolean> {
    if (!this.info.enabled) return false;
    if (Date.now() - this.lastManual < 60_000) return true;
    this.lastManual = Date.now();
    return this.check();
  }

  /** Returns false when GitHub couldn't be asked. */
  async check(): Promise<boolean> {
    const res = await fetch(`${this.apiBase}/repos/${this.repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "shelvarr-update-check" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown };
    const tag = release.tag_name;
    const url = release.html_url;
    if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) return false;
    if (typeof url !== "string" || !url.startsWith("https://github.com/")) return false;
    this.info = {
      ...this.info,
      latest: tag,
      url,
      notes: typeof release.body === "string" ? cleanNotes(release.body) : null,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      checkedAt: Date.now(),
    };
    return true;
  }
}

/** Release notes as plain Markdown lines: no HTML comments, no empty runs, bounded length. */
export function cleanNotes(body: string): string | null {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES);
  return text || null;
}

/** True when `latest` is a newer release than `current` (dev builds never are). */
export function isNewer(latest: string | null, current: string): boolean {
  if (!latest) return false;
  const parse = (v: string) => {
    const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" } : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  // Same numbers: a release beats its own pre-release.
  return b.pre !== "" && a.pre === "";
}
