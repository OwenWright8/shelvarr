import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Logo } from "@/components/Layout";
import { Button, Card, Field, Input } from "@/components/ui";

export default function AuthPage({ mode }: { mode: "create" | "signin" }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creating = mode === "create";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (creating && password !== confirm) return setError("The passwords don't match");
    setBusy(true);
    try {
      await api("POST", creating ? "/account/create" : "/login", { username, password });
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[720px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative w-full max-w-sm animate-fade-in">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo className="mb-4 h-14 w-14 rounded-2xl shadow-md" />
          <h1 className="text-2xl font-semibold">{creating ? "Welcome to Shelvarr" : "Sign in"}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {creating ? "Create the admin account for this instance." : "Sign in to manage your library's tags."}
          </p>
        </div>
        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Username" htmlFor="username">
              <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </Field>
            <Field label="Password" htmlFor="password" hint={creating ? "At least 8 characters." : undefined}>
              <Input
                id="password"
                type="password"
                autoComplete={creating ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            {creating && (
              <Field label="Confirm password" htmlFor="confirm">
                <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
            )}
            {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" loading={busy}>
              {creating ? "Create account" : "Sign in"}
            </Button>
          </form>
        </Card>
        {creating && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            This is the only account. It's separate from Audiobookshelf.
          </p>
        )}
      </div>
    </div>
  );
}
