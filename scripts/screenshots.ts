// UI smoke test and README screenshots, in one pass. Starts the fake
// Audiobookshelf with a messy demo library and a fresh Shelvarr, walks through
// setup in Chromium like a new user, does the whole move to one library, and
// checks the result on disk. No real files are touched.
//
//   npm run build && npm run screenshots          # smoke test only
//   SCREENSHOTS=1 npm run screenshots             # also writes docs/screenshots/*.png
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.ts";
import { buildApp } from "../server/app.ts";
import { ABS_TOKEN, startAbsMock, writeBook, writeMessyLibrary } from "./mock-abs.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repo, "docs/screenshots");
const write = process.env.SCREENSHOTS === "1";

// A fixed, short path, because it shows up in the screenshots.
const tmp = path.join(os.tmpdir().startsWith("/var") ? "/tmp" : os.tmpdir(), "shelvarr-demo");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const root = path.join(tmp, "audiobooks");
const incoming = path.join(tmp, "downloads");
writeMessyLibrary(root);
writeBook(path.join(incoming, "The Thursday Murder Club by Richard Osman.mp3"), { album: "The Thursday Murder Club: The Thursday Murder Club, Book 1", artist: "Richard Osman", title: "The Thursday Murder Club" }, 5000, 20);
const abs = await startAbsMock();
for (const name of ["Owen", "Alex", "Jamie"]) abs.addLibrary(`${name}'s Audiobooks`, path.join(root, `audiobooks-${name}`));
const martian = [...abs.items.values()].find((i) => i.path.includes("audiobooks-Jamie") && i.path.endsWith("The Martian"))!;
abs.users.find((u) => u.username === "jamie")!.mediaProgress.push({ libraryItemId: martian.id, currentTime: 500, progress: 0.2, duration: 2500, isFinished: false, lastUpdate: 5 });

const { app, engine } = await buildApp({ db: openDb(path.join(tmp, "db.sqlite")), version: "v1.0.0", repo: "OwenWright8/shelvarr", updateCheck: false, webRoot: path.join(repo, "dist/web") });
await app.listen({ host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

const browser = await chromium.launch();
const errors: string[] = [];
let failed = false;

async function newPage(opts: { dark?: boolean; mobile?: boolean; storage?: string } = {}) {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 920 },
    deviceScaleFactor: 2,
    colorScheme: opts.dark ? "dark" : "light",
    isMobile: opts.mobile,
    hasTouch: opts.mobile,
    storageState: opts.storage,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/401|404|Failed to load/.test(m.text()) && errors.push(`console: ${m.text()}`));
  return page;
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  if (write) await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage });
  console.log(`  ✓ ${name}`);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const idle = async () => {
  await new Promise((r) => setTimeout(r, 100));
  while (engine.status.running) await new Promise((r) => setTimeout(r, 50));
};

try {
  if (write) fs.mkdirSync(outDir, { recursive: true });
  console.log("Setup");
  const page = await newPage();
  await page.goto(base);
  await step("account", async () => {
    await page.getByLabel("Username").fill("owen");
    await page.getByLabel("Password", { exact: true }).fill("demo-password");
    await page.getByLabel("Confirm password").fill("demo-password");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByText("Connect Audiobookshelf").waitFor();
  });
  await step("audiobookshelf", async () => {
    await page.getByLabel("Audiobookshelf address").fill(abs.url);
    await page.getByLabel("API token").fill(ABS_TOKEN);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByText("Where are your audiobooks?").waitFor();
  });
  await step("folders", async () => {
    await page.getByLabel("Audiobooks folder").fill(root);
    await page.getByLabel("The same folder, as Audiobookshelf sees it").fill(root);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByText("Who shares the library?").waitFor();
  });
  await step("people, from their folders", async () => {
    for (const name of ["Jamie", "Alex", "Owen"]) {
      await page.locator("div.border-dashed", { hasText: `audiobooks-${name}` }).getByRole("button", { name: "Add" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await page.locator("li", { hasText: `old folder audiobooks-${name}` }).waitFor();
    }
    await shot(page, "setup");
    if (fs.existsSync(path.join(root, "library"))) throw new Error("setup touched the disk");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("In Shelfmark:").waitFor();
  });
  await step("downloads", async () => {
    await page.getByLabel("Downloads folder").fill(incoming);
    await page.getByRole("button", { name: "Owen" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Finish and start" }).click();
    await page.getByRole("heading", { name: "One library" }).waitFor();
  });
  const storage = path.join(tmp, "state.json");
  await page.context().storageState({ path: storage });
  await page.context().close();

  console.log("The move to one library");
  const p = await newPage({ storage });
  await step("save progress", async () => {
    await p.goto(`${base}/move`);
    await p.getByRole("button", { name: "Save progress" }).click();
    await p.getByText(/Saved \d+ entr/).first().waitFor();
    await p.getByText("Listening progress saved").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await p.getByRole("button", { name: "Scan", exact: true }).click();
    await idle();
    await shot(p, "move");
  });
  await step("review", async () => {
    await p.goto(`${base}/review`);
    await p.getByText("Once Upon a River").first().waitFor();
    await shot(p, "review");
    await p.getByRole("button", { name: /^Duplicates/ }).click();
    await p.getByText(/merge into/).first().waitFor();
    await shot(p, "duplicates");
    await p.getByRole("button", { name: /^Needs a look/ }).click();
    await p.getByText("Artemis").first().waitFor();
    await p.getByRole("button", { name: "Keep both" }).click();
    // Decided, it joins the others that are ready to go.
    await p.getByRole("button", { name: /^Ready/ }).click();
    await p.getByText("Two versions").first().waitFor();
    await p.getByRole("button", { name: /^Do all/ }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Organize" }).click();
    await p.getByText(/Done: \d+ books/).first().waitFor();
    if (!fs.existsSync(path.join(root, "library/Bonnie Jo Campbell/Once Upon a River"))) throw new Error("chapters weren't organized");
    if (!fs.existsSync(path.join(root, "podcasts/Some Show/episode 1.mp3"))) throw new Error("podcasts were touched");
  });
  await step("shared library and progress", async () => {
    await p.goto(`${base}/move`);
    await p.getByRole("button", { name: "Create it" }).click();
    await p.getByText("Shared library ready").first().waitFor();
    await p.getByRole("button", { name: "Restore" }).click();
    await p.getByText(/Restored \d+ book/).first().waitFor();
    const shared = abs.libraries.find((l) => l.name === "Audiobooks")!;
    const item = [...abs.items.values()].find((i) => i.libraryId === shared.id && i.path.endsWith("The Martian"))!;
    if (!abs.users.find((u) => u.username === "jamie")!.mediaProgress.some((m) => m.libraryItemId === item.id)) throw new Error("progress didn't come across");
    if (!item.tags.includes("Jamie")) throw new Error("tags didn't reach Audiobookshelf");
  });
  await step("library", async () => {
    await p.goto(`${base}/library`);
    await p.getByText("Project Hail Mary").first().waitFor();
    await p.locator("div.relative", { hasText: "The Martian" }).first().getByRole("button", { name: "Add Owen" }).click();
    await p.locator("div.relative", { hasText: "The Martian" }).first().getByRole("button", { name: "Remove Owen" }).waitFor();
    await shot(p, "library");
    await p.getByRole("button", { name: "Rename Airframe" }).click();
    await p.getByLabel("Title").fill("Airframe (Crichton)");
    await p.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await p.getByRole("button", { name: "Rename Airframe (Crichton)" }).waitFor();
    if (!fs.existsSync(path.join(root, "library/Michael Crichton/Airframe (Crichton)"))) throw new Error("rename didn't reach the disk");
  });
  await step("access", async () => {
    await p.goto(`${base}/`);
    await p.getByText(/can see every book/).waitFor();
    await p.goto(`${base}/access`);
    await p.locator("div.rounded-xl", { hasText: "Linked to Alex" }).getByRole("button", { name: "Change" }).click();
    await p.getByRole("button", { name: "Save to Audiobookshelf" }).click();
    await p.getByText(/Sees books tagged/).first().waitFor();
    if (abs.users.find((u) => u.username === "alex")!.permissions.accessAllTags !== false) throw new Error("access not saved");
    await shot(p, "access");
  });
  await step("new download arrives", async () => {
    await p.goto(`${base}/settings#downloads`);
    await p.getByLabel("Downloads folder").waitFor();
    await engine.tick();
    if (!fs.existsSync(path.join(root, "library/Richard Osman/The Thursday Murder Club"))) throw new Error("download wasn't organized");
  });
  await step("activity", async () => {
    await p.goto(`${base}/activity`);
    await p.getByRole("button", { name: "Empty trash" }).waitFor();
    await shot(p, "activity");
  });
  await step("settings", async () => {
    await p.goto(`${base}/settings`);
    await p.getByRole("heading", { name: "New downloads" }).waitFor();
    await shot(p, "settings", true);
  });
  await step("overview", async () => {
    await p.goto(base);
    await p.getByText("Recent activity").waitFor();
    await shot(p, "overview-light");
  });
  await p.context().close();

  console.log("Dark and mobile");
  const d = await newPage({ dark: true, storage });
  await step("dark", async () => {
    await d.goto(`${base}/library`);
    await d.getByText("Project Hail Mary").first().waitFor();
    await shot(d, "library-dark");
  });
  await d.context().close();
  const m = await newPage({ mobile: true, storage });
  await step("mobile", async () => {
    await m.goto(`${base}/library`);
    await m.getByText("Project Hail Mary").first().waitFor();
    await shot(m, "mobile-library");
  });
  await m.context().close();
} finally {
  await browser.close();
  engine.stop();
  await app.close();
  await abs.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (errors.length) {
  console.error("\nBrowser errors:\n" + errors.map((e) => "  " + e).join("\n"));
  failed = true;
}
process.exit(failed ? 1 : 0);
