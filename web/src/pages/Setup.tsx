import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Logo } from "@/components/Layout";
import { usePeople } from "@/components/people";
import { AbsForm, DownloadsForm, FoldersForm, PeopleEditor, useSettings } from "@/pages/Settings";
import { Button, Card, PageSpinner, cn } from "@/components/ui";

const STEPS = ["Audiobookshelf", "Folders", "People", "Shelfmark", "Finish"];

export default function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings();
  const people = usePeople();
  const [step, setStep] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const ignore = useMutation({
    mutationFn: () => api<{ skipped: number }>("POST", "/incoming/ignore-existing", {}),
    onSuccess: (r) => toast.success(`Left ${r.skipped} existing downloads as they are`),
    onError: (err) => toast.error(err.message),
  });
  if (!settings.data) return <PageSpinner />;
  const s = settings.data;
  const finish = async () => {
    setFinishing(true);
    await api("PUT", "/settings", { setupComplete: true });
    navigate("/move", { replace: true });
    await qc.invalidateQueries();
  };
  return (
    <div className="min-h-screen px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-2xl animate-fade-in">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="h-10 w-10 rounded-xl" />
          <div>
            <h1 className="text-xl font-semibold">Set up Shelvarr</h1>
            <p className="text-sm text-muted-foreground">Nothing is moved during setup.</p>
          </div>
        </div>
        <ol className="mb-6 grid grid-cols-5 gap-2">
          {STEPS.map((label, i) => (
            <li key={label}>
              <div className={cn("mb-2 h-1.5 rounded-full", i <= step ? "bg-primary" : "bg-muted")} />
              <span className={cn("flex items-center gap-1 text-xs font-medium", i === step ? "text-foreground" : "text-muted-foreground")}>{i < step && <Check className="h-3.5 w-3.5 text-primary" />}<span className="truncate">{label}</span></span>
            </li>
          ))}
        </ol>
        <Card className="p-5 sm:p-7">
          {step === 0 && (
            <>
              <Title title="Connect Audiobookshelf" text="Shelvarr uses it for tags, access rules, covers, online lookups and carrying over listening progress." />
              <AbsForm s={s} saveLabel="Save and continue" onSaved={() => setStep(1)} />
            </>
          )}
          {step === 1 && (
            <>
              <Title title="Where are your audiobooks?" text="Your files stay put until you approve something." />
              <FoldersForm s={s} saveLabel="Save and continue" onSaved={() => setStep(2)} />
            </>
          )}
          {step === 2 && (
            <>
              <Title title="Who shares the library?" text="Add each person and link their old folder, so their books stay theirs. Link their Audiobookshelf user too." />
              <PeopleEditor />
              <Nav back={() => setStep(1)} next={() => setStep(3)} disabled={!people.data?.length} />
            </>
          )}
          {step === 3 && (
            <>
              <Title title="New downloads from Shelfmark" text="Shelvarr watches the folder Shelfmark downloads to, and files each new book." />
              <div className="mb-5 rounded-lg bg-muted/60 p-4 text-sm">
                <p className="font-medium">In Shelfmark:</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Open your user's settings and check <strong className="font-medium text-foreground">Audiobook destination</strong> (or the default in the download settings). That folder is Shelvarr's downloads folder below.</li>
                  <li>Shelfmark's naming doesn't matter any more, so you can leave it as it is.</li>
                  <li>Shelfmark mustn't put downloads straight into Audiobookshelf's library. If it does, point it at a separate folder.</li>
                </ol>
              </div>
              <DownloadsForm s={s} saveLabel="Save" />
              {!!s.incomingDir && (
                <div className="mt-5 rounded-lg border p-4 text-sm">
                  <p className="font-medium">Already have downloads in there?</p>
                  <p className="mt-0.5 text-muted-foreground">Books you've already got would otherwise show up in Review. This leaves what's there now alone, and only handles new arrivals.</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => ignore.mutate()} loading={ignore.isPending}>Only handle new downloads</Button>
                </div>
              )}
              <Nav back={() => setStep(2)} next={() => setStep(4)} />
            </>
          )}
          {step === 4 && (
            <>
              <Title title="You're set" text="Next is a step-by-step move to one shared library. Nothing happens until you approve it." />
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>• Save everyone's listening progress</li>
                <li>• Scan, and approve the moves and duplicate merges</li>
                <li>• Create the shared library in Audiobookshelf, and bring progress back</li>
                <li>• Limit each person to their own shelf</li>
              </ul>
              <div className="mt-7 flex justify-between border-t pt-5">
                <Button variant="ghost" onClick={() => setStep(3)}><ArrowLeft className="h-4 w-4" /> Back</Button>
                <Button onClick={finish} loading={finishing}>Finish and start <ArrowRight className="h-4 w-4" /></Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function Nav({ back, next, disabled }: { back: () => void; next: () => void; disabled?: boolean }) {
  return (
    <div className="mt-7 flex justify-between border-t pt-5">
      <Button variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" /> Back</Button>
      <Button onClick={next} disabled={disabled}>Continue <ArrowRight className="h-4 w-4" /></Button>
    </div>
  );
}

function Title({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
