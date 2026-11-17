import { useState } from "react";
import {
  Check,
  Clock3,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { zh } from "../lib/locale";
import { formatDate } from "../lib/format";
import type { Approval } from "../lib/types";
import { usePolling } from "../lib/use-polling";
import {
  Button,
  EmptyState,
  ErrorNotice,
  JsonBlock,
  PageHeader,
  Panel,
  Spinner,
} from "../components/ui";

export function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const navigate = useNavigate();

  const load = async (): Promise<void> => {
    try {
      setApprovals(await api.approvals());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "审批列表加载失败。",
      );
    }
  };
  usePolling(load, 2_000);

  const decide = async (
    approval: Approval,
    decision: "approve" | "reject",
  ): Promise<void> => {
    setBusy(approval.id);
    try {
      await api.decideApproval(
        approval.id,
        decision,
        reasons[approval.id]?.trim() || undefined,
      );
      await load();
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "审批操作失败。",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="写入操作控制"
        title="审批中心"
        description="先核对写入内容，再决定是否允许执行模拟业务操作。"
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
            刷新队列
          </Button>
        }
      />
      {error === null ? null : <ErrorNotice message={error} />}
      {approvals === null ? (
        <Panel className="p-5">
          <Spinner label="正在加载审批队列" />
        </Panel>
      ) : approvals.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<ShieldCheck className="size-5" />}
            title="暂无待审批操作"
            description="任务需要执行写入操作时，会在这里等待你的决定。"
            action={
              <Button size="sm" onClick={() => navigate("/workspace")}>
                打开工作台
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {approvals.map((approval) => (
            <Panel key={approval.id} className="overflow-hidden">
              <div className="border-b border-[#e5e9e7] bg-[#fffcf3] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-md bg-[#fff1cb] text-[#8b5d09]">
                        <ShieldCheck className="size-4" />
                      </span>
                      <h2 className="text-sm font-semibold text-[#2b3732]">
                        {approval.toolName}
                      </h2>
                    </div>
                    <p className="mt-2 max-w-lg text-xs leading-5 text-[#756b58]">
                      {zh(approval.description)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/history?task=${approval.taskId}`)
                    }
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#0f766e]"
                  >
                    任务详情
                    <ExternalLink className="size-3" />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[#8a7d65]">
                  <Clock3 className="size-3" />
                  申请于 {formatDate(approval.requestedAt)}
                </div>
              </div>
              <div className="space-y-4 p-5">
                <div>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                    写入内容
                  </div>
                  <JsonBlock value={approval.input} />
                </div>
                <div>
                  <label
                    htmlFor={`reason-${approval.id}`}
                    className="mb-1.5 block text-xs font-medium text-[#52605a]"
                  >
                    审批备注
                  </label>
                  <input
                    id={`reason-${approval.id}`}
                    value={reasons[approval.id] ?? ""}
                    onChange={(event) =>
                      setReasons((current) => ({
                        ...current,
                        [approval.id]: event.target.value,
                      }))
                    }
                    placeholder="可选：填写审批原因，便于事后查看"
                    className="h-9 w-full rounded-md border border-[#d6dcd8] bg-white px-3 text-sm outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
                  />
                </div>
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === approval.id}
                    onClick={() => void decide(approval, "reject")}
                  >
                    <X className="size-3.5" />
                    拒绝写入
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === approval.id}
                    onClick={() => void decide(approval, "approve")}
                  >
                    <Check className="size-3.5" />
                    批准并继续
                  </Button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
