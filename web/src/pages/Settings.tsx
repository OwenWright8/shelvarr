import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FolderOpen, Info, KeyRound, Plug, Trash2, Users, Wand2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, formatBytes, get, type About, type Folders, type Person, type SettingsData } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { showUpdatePrompt, useAbout } from "@/components/UpdatePrompt";
import { Avatar, usePeople } from "@/components/people";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Modal, PageSpinner, Select, Switch } from "@/components/ui";

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsData>("/settings") });
}

export default function SettingsPage() {
  const settings = useSettings();
  const location = useLocation();
  useEffect(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  }, [location.hash, settings.data]);
  if (!settings.data) return <PageSpinner />;
  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader title="Settings" />
      <Card id="abs" className="scroll-mt-20">
        <CardHeader icon={<Plug className="h-5 w-5" />} title="Audiobookshelf" />
        <CardBody><AbsForm s={settings.data} /></CardBody>
      </Card>
      <Card id="folders" className="scroll-mt-20">
        <CardHeader icon={<FolderOpen className="h-5 w-5" />} title="Folders" />
        <CardBody><FoldersForm s={settings.data} /></CardBody>
      </Card>
      <Card id="people" className="scroll-mt-20">
        <CardHeader icon={<Users className="h-5 w-5" />} title="People" description="Each person is a tag in Audiobookshelf. Their old folder, if they had one, tells Shelvarr which books are theirs." />
        <CardBody><PeopleEditor /></CardBody>
      </Card>
      <Card id="downloads" className="scroll-mt-20">
        <CardHeader icon={<Wand2 className="h-5 w-5" />} title="New downloads" />
        <CardBody><DownloadsForm s={settings.data} /></CardBody>
      </Card>
      <WidgetCard />
      <PasswordCard />
      <AboutCard />
    </div>
  );
}

export function AbsForm({ s, onSaved, saveLabel = "Save" }: { s: SettingsData; onSaved?: () => void; saveLabel?: string }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(s.absUrl);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const res = await api<{ username: string; version: string | null }>("POST", "/test/abs", { url, token: token || undefined });
      await api("PUT", "/settings", { absUrl: url, ...(token ? { absToken: token } : {}) });
      return res;
    },
    onSuccess: (r) => {
      setResult({ ok: true, text: `Connected as ${r.username}${r.version ? ` (Audiobookshelf ${r.version})` : ""}` });
      qc.invalidateQueries();
      onSaved?.();
    },
    onError: (err) => setResult({ ok: false, text: err instanceof ApiError ? err.message : String(err) }),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Audiobookshelf address" htmlFor="abs-url" hint="As Shelvarr's container reaches it: http://audiobookshelf:80 on the same Docker network, or http://192.168.1.10:13378.">
        <Input id="abs-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://audiobookshelf:80" />
      </Field>
      <Field label="API token" htmlFor="abs-token" hint="In Audiobookshelf: Settings → API Keys → Add (assign it to an admin), or copy an admin's token under Settings → Users.">
        <Input id="abs-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.absTokenSet ? "Saved. Leave blank to keep it" : ""} autoComplete="off" />
      </Field>
      {result && <p className={`flex items-center gap-1.5 text-sm ${result.ok ? "text-success" : "text-destructive"}`}>{result.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{result.text}</p>}
      <Button type="submit" loading={save.isPending} disabled={!url.trim()}>{saveLabel}</Button>
    </form>
  );
}

export function FoldersCheck() {
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => get<Folders>("/folders") });
  if (!folders.data) return null;
  const f = folders.data;
  const Line = ({ label, d }: { label: string; d: Folders["library"] }) =>
    d.path ? (
      <p className={`flex items-center gap-1.5 text-sm ${d.writable ? "text-success" : "text-destructive"}`}>
        {d.writable ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {label} {d.path}: {d.writable ? "ready" : !d.exists ? "not found in this container. Check the volume." : "can't write here. Set the container's user to match your files (PUID/PGID)."}
      </p>
    ) : null;
  return (
    <div className="space-y-1.5 rounded-lg bg-muted/60 p-3">
      <Line label="Audiobooks" d={f.library} />
      <Line label="Downloads" d={f.incoming} />
      {f.folders.length > 0 && (
        <ul className="pt-1 text-xs text-muted-foreground">
          {f.folders.map((x) => (
            <li key={x.name}>{x.name}: {x.role === "person" ? "someone's old folder" : x.role === "library" ? "the tidy library" : "left alone"}{x.size ? ` · ${formatBytes(x.size)}` : ""}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FoldersForm({ s, onSaved, saveLabel = "Save" }: { s: SettingsData; onSaved?: () => void; saveLabel?: string }) {
  const qc = useQueryClient();
  const [libraryRoot, setRoot] = useState(s.libraryRoot);
  const [absRoot, setAbsRoot] = useState(s.absRoot);
  const [destSubdir, setDest] = useState(s.destSubdir);
  const save = useMutation({
    mutationFn: () => api("PUT", "/settings", { libraryRoot, absRoot, destSubdir }),
    onSuccess: () => { qc.invalidateQueries(); onSaved?.(); },
    onError: (err) => toast.error(err.message),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Audiobooks folder" htmlFor="f-root" hint="Inside this container: the folder holding everyone's books."><Input id="f-root" value={libraryRoot} onChange={(e) => setRoot(e.target.value)} /></Field>
      <Field label="The same folder, as Audiobookshelf sees it" htmlFor="f-abs" hint="Its path inside Audiobookshelf's container, like /audiobooks."><Input id="f-abs" value={absRoot} onChange={(e) => setAbsRoot(e.target.value)} /></Field>
      <Field label="Tidy books go in" htmlFor="f-dest" hint={`A new folder: ${libraryRoot}/${destSubdir}/Author/Book. Other folders next to it (like podcasts) are left alone.`}><Input id="f-dest" value={destSubdir} onChange={(e) => setDest(e.target.value)} /></Field>
      <FoldersCheck />
      <Button type="submit" loading={save.isPending}>{saveLabel}</Button>
    </form>
  );
}

export function DownloadsForm({ s, onSaved, saveLabel = "Save" }: { s: SettingsData; onSaved?: () => void; saveLabel?: string }) {
  const qc = useQueryClient();
  const people = usePeople();
  const [incomingDir, setDir] = useState(s.incomingDir);
  const [incomingMode, setMode] = useState(s.incomingMode);
  const [autoOrganize, setAuto] = useState(s.autoOrganize);
  const [defaultOwners, setOwners] = useState(s.defaultOwners);
  const save = useMutation({
    mutationFn: () => api("PUT", "/settings", { incomingDir, incomingMode, autoOrganize, defaultOwners }),
    onSuccess: () => { qc.invalidateQueries(); toast.success("Saved"); onSaved?.(); },
    onError: (err) => toast.error(err.message),
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Field label="Downloads folder" htmlFor="d-dir" hint="Inside this container: where Shelfmark puts finished audiobooks (its Audiobook destination). Leave blank to not watch one."><Input id="d-dir" value={incomingDir} onChange={(e) => setDir(e.target.value)} placeholder="/media/downloads/audiobooks" /></Field>
      <Field label="When a book comes in" htmlFor="d-mode" hint={incomingMode === "hardlink" ? "Takes no extra space, and the download can keep seeding. It needs both folders under the same mount; otherwise Shelvarr makes a checked copy." : incomingMode === "copy" ? "The download stays where it is, and the book uses space twice." : "The download is moved out. Don't use this if you seed."}>
        <Select id="d-mode" value={incomingMode} onChange={(e) => setMode(e.target.value as SettingsData["incomingMode"])}>
          <option value="hardlink">Hardlink it (keep the original for seeding)</option>
          <option value="copy">Copy it (keep the original)</option>
          <option value="move">Move it</option>
        </Select>
      </Field>
      <div className="flex items-center justify-between gap-4">
        <span><span className="block text-sm font-medium">Organize on its own when sure</span><span className="block text-xs text-muted-foreground">Otherwise every new book waits on the Review page. Books it isn't sure of always wait.</span></span>
        <Switch checked={autoOrganize} onChange={setAuto} label="Organize on its own when sure" />
      </div>
      <Field label="New books belong to" hint="Add other people from the Library when they want something you downloaded.">
        <div className="flex flex-wrap gap-2">
          {(people.data ?? []).map((p) => {
            const on = defaultOwners.includes(p.id);
            return (
              <button key={p.id} type="button" aria-pressed={on} onClick={() => setOwners(on ? defaultOwners.filter((x) => x !== p.id) : [...defaultOwners, p.id])} className={`inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] font-medium ${on ? "" : "opacity-60"}`} style={on ? { backgroundColor: `${p.color}1f`, borderColor: `${p.color}66`, color: p.color } : undefined}>
                <Avatar person={p} size="sm" /> {p.name}
              </button>
            );
          })}
        </div>
      </Field>
      <Button type="submit" loading={save.isPending}>{saveLabel}</Button>
    </form>
  );
}

export function PeopleEditor() {
  const qc = useQueryClient();
  const people = usePeople();
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => get<Folders>("/folders") });
  const users = useQuery({ queryKey: ["access"], queryFn: () => get<{ users: { id: string; name: string; isAdmin: boolean }[] }>("/access"), retry: false });
  const [editing, setEditing] = useState<Partial<Person> | null>(null);
  const del = useMutation({ mutationFn: (id: number) => api("DELETE", `/people/${id}`), onSuccess: () => qc.invalidateQueries() });
  const taken = new Set((people.data ?? []).map((p) => p.folder));
  // Old per-person folders nobody's linked yet: "audiobooks-Alex" suggests Alex.
  const suggestions = (folders.data?.folders ?? []).filter((f) => f.role === "ignored" && f.books > 0 && !taken.has(f.name)).map((f) => {
    const name = f.name.replace(/^audio-?books?[-_ ]*/i, "") || f.name;
    const user = users.data?.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
    return { folder: f.name, name, absUserId: user?.id ?? null };
  });
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-xl border">
        {(people.data ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
            <Avatar person={p} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground">Tag “{p.tag}”{p.folder ? ` · old folder ${p.folder}` : ""}{p.absUserId ? "" : " · no Audiobookshelf user linked"}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>Edit</Button>
            <button onClick={() => del.mutate(p.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={`Remove ${p.name}`}><Trash2 className="h-4 w-4" /></button>
          </li>
        ))}
        {!people.data?.length && <li className="px-3 py-3 text-sm text-muted-foreground">Nobody yet.</li>}
      </ul>
      {suggestions.map((s) => (
        <div key={s.folder} className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-sm">
          <span className="flex-1">Folder <strong className="font-medium">{s.folder}</strong> looks like {s.name}'s{s.absUserId ? ", and there's a matching user" : ""}.</span>
          <Button size="sm" variant="outline" onClick={() => setEditing({ name: s.name, tag: s.name, folder: s.folder, absUserId: s.absUserId })}>Add</Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setEditing({})}>Add a person</Button>
      {editing && <PersonModal person={editing} users={users.data?.users ?? []} folders={(folders.data?.folders ?? []).map((f) => f.name)} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PersonModal({ person, users, folders, onClose }: { person: Partial<Person>; users: { id: string; name: string }[]; folders: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(person.name ?? "");
  const [tag, setTag] = useState(person.tag ?? "");
  const [absUserId, setUser] = useState(person.absUserId ?? "");
  const [folder, setFolder] = useState(person.folder ?? "");
  const save = useMutation({
    mutationFn: () => {
      const body = { name, tag: tag || name, absUserId: absUserId || null, folder: folder || null };
      return person.id ? api("PATCH", `/people/${person.id}`, body) : api("POST", "/people", body);
    },
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
    onError: (err) => toast.error(err.message),
  });
  return (
    <Modal open onClose={onClose} title={person.id ? `Edit ${person.name}` : "Add a person"} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>{person.id ? "Save" : "Add"}</Button></>}>
      <div className="space-y-4 pb-2">
        <Field label="Name" htmlFor="p-name"><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Tag in Audiobookshelf" htmlFor="p-tag"><Input id="p-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={name} /></Field>
        <Field label="Audiobookshelf user" htmlFor="p-user" hint="Needed for access rules and to carry over their listening progress.">
          <Select id="p-user" value={absUserId} onChange={(e) => setUser(e.target.value)}><option value="">None</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
        </Field>
        <Field label="Their old folder" htmlFor="p-folder" hint="Books found there are theirs.">
          <Select id="p-folder" value={folder} onChange={(e) => setFolder(e.target.value)}><option value="">None</option>{folders.map((f) => <option key={f} value={f}>{f}</option>)}</Select>
        </Field>
      </div>
    </Modal>
  );
}

function WidgetCard() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["widget-keys"], queryFn: () => get<{ id: number; label: string }[]>("/widget-keys") });
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => api<{ key: string }>("POST", "/widget-keys", { label: "Homepage" }), onSuccess: (r) => { setMade(r.key); qc.invalidateQueries({ queryKey: ["widget-keys"] }); } });
  const revoke = useMutation({ mutationFn: (id: number) => api("DELETE", `/widget-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["widget-keys"] }) });
  return (
    <Card id="widget" className="scroll-mt-20">
      <CardHeader icon={<KeyRound className="h-5 w-5" />} title="Homepage widget" description="A read-only key for the Custom API widget. The README has the snippet." />
      <CardBody className="space-y-3">
        {made && <Input readOnly value={made} aria-label="New key" onFocus={(e) => e.target.select()} />}
        <ul className="space-y-1 text-sm">{keys.data?.map((k) => <li key={k.id} className="flex items-center justify-between"><span>{k.label}</span><button onClick={() => revoke.mutate(k.id)} className="text-xs text-muted-foreground hover:text-foreground">Revoke</button></li>)}</ul>
        <Button variant="outline" size="sm" onClick={() => create.mutate()}>Create key</Button>
      </CardBody>
    </Card>
  );
}

function PasswordCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const save = useMutation({ mutationFn: () => api("POST", "/account/password", { current, next }), onSuccess: () => { toast.success("Password changed"); setOpen(false); }, onError: (err) => toast.error(err.message) });
  return (
    <Card>
      <CardBody className="flex items-center justify-between text-sm"><span>Password</span><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Change</Button></CardBody>
      <Modal open={open} onClose={() => setOpen(false)} title="Change password" footer={<Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
        <div className="space-y-3 pb-2">
          <Field label="Current password" htmlFor="pw-c"><Input id="pw-c" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" htmlFor="pw-n"><Input id="pw-n" type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function AboutCard() {
  const about = useAbout();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: () => api<About>("POST", "/about/check"),
    onSuccess: (data) => {
      qc.setQueryData(["about"], data);
      if (data.updateAvailable) showUpdatePrompt();
      else toast.success(`You're up to date (${data.version})`);
    },
    onError: (err) => toast.error(err.message),
  });
  if (!about.data) return null;
  const a = about.data;
  return (
    <Card id="about">
      <CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2"><Info className="h-4 w-4 text-muted-foreground" /><span className="font-semibold">Shelvarr</span> <Badge>{a.version}</Badge></span>
        <span className="flex gap-4">
          {a.updateAvailable ? <button onClick={showUpdatePrompt} className="font-medium text-primary hover:underline">What's new</button> : a.update.enabled && <button onClick={() => check.mutate()} className="font-medium text-primary hover:underline">{check.isPending ? "Checking…" : "Check for updates"}</button>}
          <a href={`https://github.com/${a.repo}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">GitHub</a>
        </span>
      </CardBody>
    </Card>
  );
}
