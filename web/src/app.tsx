import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "./components/layout";
import { Button, ErrorNotice, Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import { ApprovalsPage } from "./pages/approvals-page";
import { DashboardPage } from "./pages/dashboard-page";
import { HistoryPage } from "./pages/history-page";
import { EvaluationPage } from "./pages/evaluation-page";
import { WorkspacePage } from "./pages/workspace-page";

export function App() {
  const { session, loading, error, refresh } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f2f5f2]">
        <Spinner label="正在打开工作区" />
      </div>
    );
  }
  if (session === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f2f5f2] p-6">
        <div className="w-full max-w-md rounded-lg border border-[#dce2de] bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-[#26322e]">暂时无法打开工作区</h1>
          <div className="mt-3"><ErrorNotice message={error ?? "无法建立访客会话，请重试。"} /></div>
          <Button className="mt-4" onClick={() => void refresh()}>重试</Button>
        </div>
      </div>
    );
  }
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="evaluations" element={<EvaluationPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
