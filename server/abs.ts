// A small Audiobookshelf API client: just what Shelvarr needs. Uses an admin's
// API token (Settings → Users, or Settings → API Keys in newer versions).

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;
  folders: { id: string; fullPath: string }[];
}

export interface AbsItem {
  id: string;
  libraryId: string;
  path: string;
  relPath: string;
  media: { tags?: string[]; coverPath?: string | null; metadata?: { title?: string; authorName?: string; seriesName?: string } };
}

export interface AbsPermissions {
  accessAllTags?: boolean;
  selectedTagsNotAccessible?: boolean;
  [key: string]: unknown;
}

export interface AbsUser {
  id: string;
  username: string;
  type: string;
  isActive?: boolean;
  permissions?: AbsPermissions;
  itemTagsSelected?: string[];
  librariesAccessible?: string[];
  mediaProgress?: AbsProgress[];
  bookmarks?: AbsBookmark[];
}

export interface AbsProgress {
  libraryItemId: string;
  episodeId?: string | null;
  currentTime?: number;
  progress?: number;
  duration?: number;
  isFinished?: boolean;
  hideFromContinueListening?: boolean;
  lastUpdate?: number;
  startedAt?: number;
  finishedAt?: number | null;
}

export interface AbsBookmark {
  libraryItemId: string;
  time: number;
  title: string;
}

const isAdmin = (u: AbsUser) => u.type === "admin" || u.type === "root";

export class Abs {
  baseUrl: string;
  token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, `Audiobookshelf ${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`.trim());
    }
    // Some answers are plain "OK", and some are empty whatever they claim to be.
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("json") && text ? JSON.parse(text) : text) as T;
  }

  /** Checks the address and that the token belongs to an administrator. */
  async test(): Promise<{ username: string; version: string | null; libraries: AbsLibrary[] }> {
    const me = await this.request<AbsUser>("GET", "/api/me");
    if (!isAdmin(me)) throw new Error(`That token belongs to “${me.username}”, who isn't an administrator`);
    const status = await this.request<{ serverVersion?: string }>("GET", "/status").catch(() => null);
    return { username: me.username, version: status?.serverVersion ?? null, libraries: await this.libraries() };
  }

  async libraries(): Promise<AbsLibrary[]> {
    const res = await this.request<{ libraries: AbsLibrary[] }>("GET", "/api/libraries");
    return res.libraries.filter((l) => l.mediaType === "book");
  }

  async createLibrary(name: string, fullPath: string): Promise<AbsLibrary> {
    return this.request("POST", "/api/libraries", { name, mediaType: "book", folders: [{ fullPath }] });
  }

  async scan(libraryId: string) {
    await this.request("POST", `/api/libraries/${libraryId}/scan`);
  }

  async items(libraryId: string): Promise<AbsItem[]> {
    const out: AbsItem[] = [];
    for (let page = 0; ; page++) {
      const res = await this.request<{ results: AbsItem[]; total: number }>("GET", `/api/libraries/${libraryId}/items?limit=200&page=${page}`);
      out.push(...res.results);
      if (!res.results.length || out.length >= res.total) return out;
    }
  }

  async setTags(updates: { id: string; tags: string[] }[]) {
    for (let i = 0; i < updates.length; i += 100) {
      const batch = updates.slice(i, i + 100).map((u) => ({ id: u.id, mediaPayload: { tags: u.tags } }));
      await this.request("POST", "/api/items/batch/update", batch);
    }
  }

  /** Sets a book's series. This replaces its whole list, so only use it on books with none. */
  async setSeries(updates: { id: string; name: string; sequence: string | null }[]) {
    for (let i = 0; i < updates.length; i += 100) {
      const batch = updates.slice(i, i + 100).map((u) => ({ id: u.id, mediaPayload: { metadata: { series: [{ name: u.name, sequence: u.sequence }] } } }));
      await this.request("POST", "/api/items/batch/update", batch);
    }
  }

  async renameTag(tag: string, newTag: string) {
    await this.request("POST", "/api/tags/rename", { tag, newTag });
  }

  async users(): Promise<AbsUser[]> {
    const res = await this.request<{ users: AbsUser[] }>("GET", "/api/users");
    return res.users;
  }

  /** One user in full, with their progress and bookmarks. */
  async user(id: string): Promise<AbsUser> {
    return this.request("GET", `/api/users/${id}`);
  }

  /** Limits a user to items with these tags; an empty list lifts the limit. */
  async setAllowedTags(user: AbsUser, tags: string[]) {
    await this.request("PATCH", `/api/users/${user.id}`, {
      permissions: { ...user.permissions, accessAllTags: tags.length === 0, selectedTagsNotAccessible: false },
      itemTagsSelected: tags,
    });
  }

  async setLibraryAccess(user: AbsUser, libraryIds: string[]) {
    await this.request("PATCH", `/api/users/${user.id}`, { librariesAccessible: libraryIds });
  }

  /**
   * Runs something as another user, through a short-lived API key: progress
   * can only be written by the person it belongs to. Needs Audiobookshelf
   * 2.26 or newer. The key is always deleted again.
   */
  async asUser<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const made = await this.request<{ apiKey: { id: string; apiKey: string } }>("POST", "/api/api-keys", {
      name: "shelvarr-progress-restore",
      userId,
      isActive: true,
      expiresIn: 3600,
    });
    try {
      return await fn(made.apiKey.apiKey);
    } finally {
      await this.request("DELETE", `/api/api-keys/${made.apiKey.id}`).catch(() => {});
    }
  }

  async setProgress(token: string, itemId: string, p: AbsProgress) {
    await this.request(
      "PATCH",
      `/api/me/progress/${itemId}`,
      {
        currentTime: p.currentTime,
        progress: p.progress,
        duration: p.duration,
        isFinished: p.isFinished,
        hideFromContinueListening: p.hideFromContinueListening,
        ...(p.finishedAt ? { finishedAt: p.finishedAt } : {}),
        ...(p.startedAt ? { startedAt: p.startedAt } : {}),
        ...(p.lastUpdate ? { lastUpdate: p.lastUpdate } : {}),
      },
      token,
    );
  }

  async addBookmark(token: string, itemId: string, b: AbsBookmark) {
    await this.request("POST", `/api/me/item/${itemId}/bookmark`, { time: b.time, title: b.title }, token);
  }

  /** Audiobookshelf's own metadata search, so Shelvarr needs no keys of its own. */
  async searchBooks(title: string, author: string, provider: string): Promise<{ title: string; author: string; narrator?: string; publishedYear?: string; series?: { series: string; sequence?: string | null }[] }[]> {
    const q = new URLSearchParams({ title, author, provider });
    const res = await this.request<unknown>("GET", `/api/search/books?${q}`);
    if (!Array.isArray(res)) return [];
    return res
      .filter((r) => typeof r?.title === "string" && typeof r?.author === "string")
      .map((r) => ({ title: r.title, author: r.author, narrator: r.narrator ?? undefined, publishedYear: r.publishedYear ?? undefined, series: Array.isArray(r.series) ? r.series : undefined }));
  }

  async cover(itemId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/api/items/${itemId}/cover?width=400`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
  }
}
