// Turning messy tags and file names into a clean author and title. Everything
// here is pure text handling; the cases come from real libraries, so each odd
// regex below has a real file name behind it (see test/naming.test.ts).

/** For comparing names: case, accents, punctuation and spacing don't matter. */
export function nameKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const JUNK_BRACKET =
  /[([{]\s*(?:unabridged|abridged|audiobook|audio ?book|retail|mp3|m4b|m4a|flac|aac|\d+\s*k(?:bps)?|(?:19|20)\d\d|(?:asin\.?\s*)?b0[a-z0-9]{8}|\d{10,13}|read by [^)\]}]*|narrated by [^)\]}]*|h2oking)\s*[)\]}]/gi;

/** Removes edition noise, keeping what tells editions apart like "(Full-Cast Edition)". */
export function cleanName(raw: string): string {
  let s = raw.normalize("NFC").replace(/_ /g, ": ").replace(/_/g, " ");
  // No spaces at all: dots are the separators.
  if (!s.includes(" ") && s.split(".").length > 2) s = s.replace(/\./g, " ");
  s = s.replace(JUNK_BRACKET, " ").replace(/\{[^}]*\}/g, " ").replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/[’‘]/g, "'");
  return s.replace(/\s+/g, " ").replace(/^[\s\-–:,.]+|[\s\-–:,]+$/g, "").trim();
}

/** Takes the book's own title out of "Series #2: Title" and "Title: Series, Book 1" forms. */
export function bookTitle(raw: string): string {
  let s = cleanName(raw);
  // "Dungeon Crawler Carl, Book 2 - Carl's Doomsday Scenario"
  let m = s.match(/^.+?,\s*Book\s+[\w.]+\s*[-–:]\s*(.+)$/i);
  if (m) s = m[1];
  // "Hunger Games #2: Catching Fire", "Diary of a Wimpy Kid 16 - Diary of a Wimpy Kid: Big Shot"
  m = s.match(/^.+?\s#?\d{1,3}\s*[:\-–]\s+(.+)$/);
  if (m) s = m[1];
  // "The Wishing Spell: The Land of Stories, Book 1", "A Parade of Horribles - Dungeon Crawler Carl, Book 8"
  s = s.replace(/\s*(?::|\s-\s|\s–\s)\s*[^:]+?,\s*(?:Book|Vol(?:ume)?\.?)\s+[\w.]+$/i, "");
  // "The Lost World - Book Two in the Jurassic Park Series"
  s = s.replace(/\s*[-–:]\s*Book\s+\w+\s+(?:in|of)\s+.+$/i, "");
  // "Airframe: A Novel", "The Kissing Bug: A True Story of …", "Ballad: A Hunger Games Novel"
  s = s.replace(/\s*:\s*(?:An?\s+)?(?:[\w'’-]+\s+){0,3}(?:novel|memoir)$/i, "");
  s = s.replace(/\s*:\s*An?\s+(?:true\s+)?story\b.*$/i, "");
  return s.trim();
}

const NOT_AN_AUTHOR = /^(?:unknown|unknown artist|various|various artists|va|audiobook|audiobooks|n\/?a|null|none|author|(?:narrator|narrated by|read by)\b.*)$/i;

/**
 * The first real author from a tag: "John Green, Kate Rudd" and
 * "Michael Crichton/Scott Brick" credit the narrator too, and
 * "King, Stephen" is one person written backwards.
 */
export function firstAuthor(raw: string | null | undefined, narrators: string[] = []): string | null {
  if (!raw) return null;
  const text = raw.normalize("NFC").trim();
  const narrator = new Set(narrators.flatMap((n) => n.split(/\s*[,;/&]\s*/)).map(nameKey));
  const lastFirst = text.match(/^([\p{L}'’-]+),\s*([\p{L}.'’-]+(?:\s[\p{L}.'’-]+)?)$/u);
  if (lastFirst && !lastFirst[2].includes(" ")) return tidyAuthor(`${lastFirst[2]} ${lastFirst[1]}`);
  const parts = text.split(/\s*(?:[,;/&]|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    if (NOT_AN_AUTHOR.test(p) || narrator.has(nameKey(p))) continue;
    return tidyAuthor(p);
  }
  // Everyone credited is also the narrator (authors reading their own books).
  const first = parts.find((p) => !NOT_AN_AUTHOR.test(p));
  return first ? tidyAuthor(first) : null;
}

function tidyAuthor(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const FILE_EXT = /\.[a-z0-9]{2,5}$/i;

/** Does this look like someone's name, rather than a title? */
export function looksLikePerson(s: string): boolean {
  const t = s.trim();
  if (!t || /\d/.test(t) || /[:!?]/.test(t) || /\b(?:edition|cast|unabridged|abridged|novel|series|book|stories)\b/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (/^(?:the|a|an|of|in|on|my|and|to|for|with|how|why)$/i.test(words[0])) return false;
  return words.every((w) => /^(?:\p{Lu}|\p{Lu}\.)/u.test(w) || /^(?:van|von|de|del|la|le|bin|ibn)$/i.test(w));
}

export interface ParsedName {
  author?: string;
  title?: string;
  year?: string;
  narrator?: string;
}

/** Reads a file or folder name: "Author - Title", "Title by Author", "Title (Year) (Author)" and friends. */
export function parseName(raw: string): ParsedName {
  const name = raw.replace(FILE_EXT, "").normalize("NFC");
  const out: ParsedName = {};
  out.year = name.match(/[([](?:19|20)\d\d[)\]]/)?.[0].slice(1, 5) ?? name.match(/^((?:19|20)\d\d)\s*[-–]\s/)?.[1];
  out.narrator = name.match(/[([](?:read|narrated) by ([^)\]]+)[)\]]/i)?.[1]?.trim();
  // "It (2016) (Stephen King) {ASIN…} [H2OKing]"
  const paren = [...name.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]).find((p) => looksLikePerson(p));
  let s = cleanName(name.replace(/^(?:19|20)\d\d\s*[-–]\s*/, "").replace(/^\d{1,3}\s+(?=\S)/, ""));
  if (paren) {
    out.author = paren;
    s = cleanName(s.replace(`(${paren})`, " "));
  }
  const by = s.match(/^(.+?)\s+by\s+([\p{Lu}][^-–]+)$/u);
  if (by && looksLikePerson(by[2])) return { ...out, title: bookTitle(by[1]), author: by[2].trim() };
  // Runs of " - ", ignoring empties: "Mayci Neeley -   - Told You So".
  const parts = s.split(/\s+[-–]+\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const firstIsPerson = looksLikePerson(parts[0]);
    const lastIsPerson = looksLikePerson(parts[parts.length - 1]);
    if (firstIsPerson && !(lastIsPerson && parts.length === 2 && out.author)) {
      out.author ??= parts[0];
      // "Andy Weir - Project Hail Mary  - Project Hail Mary": the same title twice.
      out.title = bookTitle(parts.slice(1).join(" - "));
      const rest = parts.slice(1);
      if (rest.length > 1) {
        const last = rest[rest.length - 1];
        const titled = bookTitle(rest[0]);
        if (nameKey(last) === nameKey(titled) || nameKey(titled).endsWith(nameKey(last))) out.title = titled;
        else if (nameKey(last).includes(nameKey(titled))) out.title = titled;
        else out.title = bookTitle(rest.length > 2 && /\b\d+$/.test(rest[0]) ? rest[1] : rest[0]);
      }
      return out;
    }
    if (lastIsPerson && parts.length === 2) return { ...out, author: out.author ?? parts[1], title: bookTitle(parts[0]) };
  }
  if (s) out.title = bookTitle(s);
  return out;
}

const WINDOWS_BAD = /[<>:"/\\|?*\u0000-\u001f]/g;

/** A safe single path segment: no separators, no leading dots, no trailing dots or spaces. */
export function safeSegment(raw: string): string {
  const s = raw
    .normalize("NFC")
    .replace(/:\s*/g, " - ")
    .replace(WINDOWS_BAD, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (!s || s === "." || s === "..") return "Unknown";
  // Bytes matter on disk, but this is far below the 255-byte limit for real names.
  return s.length > 120 ? s.slice(0, 120).trim() : s;
}

/** Part/track files: "Book - pt01", "Book - Part 02", "Children of Time - 021", "Chapter 5". */
export function stripPartNumber(stem: string): string {
  return stem
    .replace(/[\s._-]*\b(?:pt|part|disc|disk|cd|ch|chap|chapter|track|tape|side)[\s._-]*\d+\s*$/i, "")
    .replace(/[\s._-]+\d{1,4}\s*$/, "")
    .replace(/^\d{1,4}[\s._-]+/, "")
    .trim();
}

export function looksLikePartName(stem: string): boolean {
  return /(?:^|[\s._-])(?:pt|part|disc|disk|cd|ch|chap|chapter|track|tape)[\s._-]*\d+\s*$/i.test(stem) || /(?:^|[\s._-])\d{1,4}\s*$/.test(stem) || /^\d{1,4}(?:[\s._-]|$)/.test(stem);
}

/** A title that just describes one file, not a book: "Track 01", "Chapter 5", "01". */
export function isGenericTitle(s: string): boolean {
  return /^(?:track|chapter|part|disc|cd|side|tape|audio|untitled)?[\s._-]*\d*$/i.test(s.trim()) || /^(?:unknown|untitled)/i.test(s.trim());
}

export interface SeriesInfo {
  name: string;
  sequence: string | null;
}

const WORD_NUMBERS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };

function bookNumber(raw: string): string | null {
  const s = raw.toLowerCase();
  if (WORD_NUMBERS[s]) return WORD_NUMBERS[s];
  return /^\d+(?:\.\d+)?$/.test(s) ? s.replace(/^0+(?=\d)/, "") : null;
}

/** "Dungeon Crawler Carl #4" or "Dune, Book 1", as metadata files and tags write them. */
export function parseSeriesLabel(raw: string): SeriesInfo | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(.+?)\s*(?:#|,\s*Book\s+)(\S+)$/i);
  return m ? { name: m[1].trim(), sequence: bookNumber(m[2]) } : { name: s, sequence: null };
}

/** The series named inside a title. Every pattern here comes from a real album tag. */
export function parseSeries(raw: string): SeriesInfo | null {
  const s = cleanName(raw);
  const found = (name: string, num: string): SeriesInfo | null => {
    const sequence = bookNumber(num);
    return sequence && name.trim() ? { name: name.trim(), sequence } : null;
  };
  // "Dungeon Crawler Carl, Book 2 - Carl's Doomsday Scenario"
  let m = s.match(/^(.+?),\s*Book\s+([\w.]+)\s*[-–:]\s*.+$/i);
  if (m) return found(m[1], m[2]);
  // "The Gate of the Feral Gods: Dungeon Crawler Carl, Book 4"
  m = s.match(/^.+?(?::|\s[-–]\s)\s*([^:]+?),\s*(?:Book|Vol(?:ume)?\.?)\s+([\w.]+)$/i);
  if (m) return found(m[1], m[2]);
  // "The Lost World - Book Two in the Jurassic Park Series"
  m = s.match(/^.+?[-–:]\s*Book\s+(\w+)\s+(?:in|of)\s+(?:the\s+)?(.+?)(?:\s+Series)?$/i);
  if (m) return found(m[2], m[1]);
  // "Hunger Games #2: Catching Fire", "Diary of a Wimpy Kid 16 - Diary of a Wimpy Kid: Big Shot"
  m = s.match(/^(.+?)\s#?(\d{1,3}(?:\.\d+)?)\s*[:\-–]\s+.+$/);
  if (m) return found(m[1], m[2]);
  return null;
}

/** For matching series spelled with and without a leading "The". */
export function seriesKey(name: string): string {
  return nameKey(name).replace(/^the /, "");
}
