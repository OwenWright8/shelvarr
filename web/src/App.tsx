import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, get, type Session } from "@/lib/api";
import { Layout } from "@/components/Layout";
import { PageSpinner } from "@/components/ui";
import AuthPage from "@/pages/Auth";
import SetupPage from "@/pages/Setup";
import OverviewPage from "@/pages/Overview";
import ReviewPage from "@/pages/Review";
import LibraryPage from "@/pages/Library";
import MovePage from "@/pages/Move";
import AccessPage from "@/pages/Access";
import ActivityPage from "@/pages/Activity";
import SettingsPage from "@/pages/Settings";

export default function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => get<Session>("/session"), staleTime: Infinity });

  useEffect(() => {
    const onSignedOut = () => qc.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener("shelvarr:signed-out", onSignedOut);
    return () => window.removeEventListener("shelvarr:signed-out", onSignedOut);
  }, [qc]);

  if (session.isLoading || !session.data) return <PageSpinner />;
  const s = session.data;

  if (!s.authenticated) return <AuthPage mode={s.needsAccount ? "create" : "signin"} />;
  if (!s.setupComplete) return <SetupPage />;

  const signOut = async () => {
    await api("POST", "/logout").catch(() => {});
    qc.clear();
    qc.invalidateQueries({ queryKey: ["session"] });
  };

  return (
    <Routes>
      <Route element={<Layout onSignOut={signOut} />}>
        <Route index element={<OverviewPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="move" element={<MovePage />} />
        <Route path="access" element={<AccessPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
