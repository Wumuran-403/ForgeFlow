import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Button, EmptyState, ErrorNotice, JsonBlock, PageHeader, Panel, Spinner } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDuration, formatNumber, formatRatio } from "../lib/format";
import { zh } from "../lib/locale";
import type { EvaluationMetric, EvaluationReport, EvaluationRun } from "../lib/types";

export function EvaluationPage() {
  const { session } = useAuth();
  const [runs, setRuns] = useState<EvaluationRun[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const loadRuns = async (preferredId?: string): Promise<void> => {
    const history = await api.evaluations();
    setRuns(history);
    const nextId = preferredId ?? selectedId ?? history[0]?.id ?? null;
    setSelectedId(nextId);
    if (nextId !== null) setReport(await api.evaluation(nextId));
    else setReport(null);
  };

  useEffect(() => {
    void loadRuns().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : "评测历史加载失败。");
    });
  }, []);

  const selectRun = async (runId: string): Promise<void> => {
    setSelectedId(runId);
    setReport(null);
    try {
      setReport(await api.evaluation(runId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "评测报告加载失败。");
    }
  };

  const runSuite = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const run = await api.runEvaluation();
      await loadRuns(run.id);
    } catch (runError) {
      setError(runError instanceof ApiError && runError.code === "WEB_EVALUATION_ALREADY_RUNNING"
        ? "预设评测正在运行，请等待完成后再启动。"
        : runError instanceof Error ? runError.message : "评测运行失败。");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="固定测试集"
        title="评测中心"
        description="查看服务端预设评测的结果和每个案例的判定。"
        actions={<div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void loadRuns().catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "刷新失败。"))}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
          <Button size="sm" disabled={running || session?.capabilities.runEvaluation !== true} onClick={() => void runSuite()}>
            <Play className="size-3.5" /> {running ? "评测运行中…" : session?.capabilities.runEvaluation === true ? "运行预设评测" : "仅查看报告"}
          </Button>
        </div>}
      />
      <div className="rounded-lg border border-[#c8ddd7] bg-[#f2f8f6] px-4 py-3 text-xs leading-5 text-[#315f58]">
        <span className="font-semibold">仅运行预设测试。</span> 这里不能上传脚本或指定 MCP 服务。结果来自固定测试数据，不代表真实大模型的成功率。{session?.capabilities.runEvaluation === true ? "本地环境可有限频率地运行评测。" : "公开环境仅可查看已有报告。"}
      </div>
      {error === null ? null : <ErrorNotice message={error} />}
      <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
        <Panel className="overflow-hidden self-start">
          <div className="border-b border-[#e4e8e6] px-4 py-3">
            <div className="text-sm font-semibold text-[#2b3732]">评测历史</div>
            <div className="mt-1 text-xs text-[#7a8580]">从 SQLite 读取的公开测试集记录</div>
          </div>
          {runs === null ? <div className="p-5"><Spinner label="正在加载评测历史" /></div>
            : runs.length === 0 ? <EmptyState icon={<FlaskConical className="size-5" />} title="暂无评测记录" description="运行预设测试集后，这里会出现保存的报告。" />
            : <div className="max-h-[720px] divide-y divide-[#edf0ee] overflow-y-auto">
              {runs.map((run) => <button key={run.id} type="button" onClick={() => void selectRun(run.id)}
                className={`w-full px-4 py-4 text-left transition-colors ${selectedId === run.id ? "bg-[#eef5f2]" : "hover:bg-[#f9fbfa]"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-semibold text-[#35423d]">{run.id.slice(0, 18)}</span>
                  <RunStatus status={run.status} />
                </div>
                <div className="mt-2 text-xs text-[#63706b]">{run.suiteVersion}</div>
                <div className="mt-1 flex justify-between text-[11px] text-[#8a958f]">
                  <span>{formatDate(run.startedAt)}</span>
                  <span>{run.passedCount ?? 0}/{run.caseCount}</span>
                </div>
              </button>)}
            </div>}
        </Panel>
        <Panel className="min-h-[640px] overflow-hidden">
          {selectedId !== null && report === null ? <div className="p-6"><Spinner label="正在加载评测报告" /></div>
            : report === null ? <EmptyState icon={<FlaskConical className="size-5" />} title="选择一条评测记录" description="历史报告可以从 SQLite 重新读取。" />
            : <EvaluationReportView report={report} />}
        </Panel>
      </div>
    </div>
  );
}

function EvaluationReportView({ report }: { report: EvaluationReport }) {
  const metrics = useMemo(() => new Map(report.run.aggregate?.metrics.map((metric) => [metric.name, metric]) ?? []), [report]);
  const deterministic = report.run.providerId.includes("deterministic") || report.run.providerId.includes("mock");
  return <div>
    <div className="border-b border-[#e4e8e6] px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#0f766e]">ForgeFlow 固定评测集</div>
          <h2 className="mt-2 text-xl font-semibold text-[#26322e]">{report.run.suiteVersion}</h2>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7a8580]">
            <span className="font-mono">{report.run.id}</span>
            <span>{formatDate(report.run.startedAt)}</span>
            <span>{report.run.finishedAt === null ? "仍在运行" : `完成于 ${formatDate(report.run.finishedAt)}`}</span>
          </div>
        </div>
        <div className="rounded-md border border-[#c8ddd7] bg-[#f2f8f6] px-3 py-2 text-xs text-[#315f58]">
          <div className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="size-3.5" />{deterministic ? "固定测试 · 未调用模型" : "使用模型运行"}</div>
          <div className="mt-1 font-mono text-[10px]">{report.run.providerId}</div>
        </div>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="案例" value={`${report.run.aggregate?.passedCount ?? 0} / ${report.run.caseCount}`} detail={`${report.run.aggregate?.failedCount ?? 0} 个失败`} />
        <MetricCard label="任务成功率" metric={metrics.get("task_success_rate")} />
        <MetricCard label="工具调用准确率" metric={metrics.get("tool_call_accuracy")} />
        <MetricCard label="恢复成功率" metric={metrics.get("recovery_success_rate")} />
        <MetricCard label="重复执行率" metric={metrics.get("duplicate_execution_rate")} />
        <MetricCard label="循环检出率" metric={metrics.get("loop_detection_rate")} />
        <MetricCard label="MCP 成功率" metric={metrics.get("mcp_tool_execution_success_rate")} />
        <SummaryCard label="Token 用量" value={`实际 ${formatNumber(metrics.get("provider_token_usage")?.value)} · 估算 ${formatNumber(metrics.get("estimated_token_usage")?.value)}`} detail="模型实际用量与估算值分别统计" />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <LatencyCard label="平均耗时" metric={metrics.get("average_task_latency_ms")} />
        <LatencyCard label="P50 耗时" metric={metrics.get("p50_task_latency_ms")} />
        <LatencyCard label="P95 耗时" metric={metrics.get("p95_task_latency_ms")} />
      </div>
    </div>
    <div className="p-5 sm:p-6">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-[#2b3732]">案例结果</h3><p className="mt-1 text-xs text-[#7a8580]">共 {report.cases.length} 个案例，可查看判定与失败原因。</p></div>
      </div>
      <div className="overflow-x-auto rounded-md border border-[#e1e6e3]">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-[#e8ecea] bg-[#fafbfa] text-[10px] uppercase tracking-[0.08em] text-[#7a8580]"><tr>
            <th className="px-3 py-2.5 font-semibold">案例</th><th className="px-3 py-2.5 font-semibold">类别</th><th className="px-3 py-2.5 font-semibold">状态</th><th className="px-3 py-2.5 font-semibold">工具</th><th className="px-3 py-2.5 font-semibold">耗时</th><th className="px-3 py-2.5 font-semibold">失败原因</th>
          </tr></thead>
          <tbody className="divide-y divide-[#edf0ee]">{report.cases.map((item) => <tr key={item.caseId}>
            <td className="px-3 py-3 font-mono text-[#35423d]">{item.caseId}</td><td className="px-3 py-3 text-[#63706b]">{zh(item.category)}</td>
            <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium ${item.status === "passed" ? "bg-[#eef7f0] text-[#2f7440]" : "bg-[#fff1ef] text-[#9f2f24]"}`}>{item.status === "passed" ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}{item.status === "passed" ? "通过" : "未通过"}</span></td>
            <td className="px-3 py-3 tabular-nums text-[#52605a]">{item.verdict.correctToolCalls}/{item.verdict.expectedToolCalls}{item.verdict.unexpectedToolCalls > 0 ? ` +${item.verdict.unexpectedToolCalls} 次意外调用` : ""}</td>
            <td className="px-3 py-3 tabular-nums text-[#52605a]">{formatDuration(item.latencyMs)}</td>
            <td className="px-3 py-3 text-[#7a4a43]">{item.error?.message ?? (item.verdict.reasons.length === 0 ? "—" : item.verdict.reasons.join(", "))}
              <details className="mt-1"><summary className="cursor-pointer text-[10px] text-[#0f766e]">结构化详情</summary><div className="mt-2"><JsonBlock value={{ expected: item.expected, observation: item.observation, verdict: item.verdict }} maxHeight="12rem" /></div></details>
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </div>;
}

function RunStatus({ status }: { status: EvaluationRun["status"] }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${status === "completed" ? "bg-[#eef7f0] text-[#2f7440]" : status === "failed" ? "bg-[#fff1ef] text-[#9f2f24]" : "bg-[#fff8e8] text-[#855a0a]"}`}>{zh(status)}</span>;
}
function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="rounded-md border border-[#e1e6e3] bg-[#fafbfa] p-3"><div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">{label}</div><div className="mt-1 text-lg font-semibold text-[#2d3934]">{value}</div><div className="mt-1 text-[10px] text-[#8a958f]">{detail}</div></div>; }
function MetricCard({ label, metric }: { label: string; metric: EvaluationMetric | undefined }) { const denominator = metric?.denominator ?? 0; return <SummaryCard label={label} value={metric === undefined || denominator === 0 ? "暂无" : formatRatio(metric.numerator ?? 0, denominator)} detail={metric === undefined ? "暂无指标" : `${formatNumber(metric.numerator ?? 0)} / ${formatNumber(denominator)}`} />; }
function LatencyCard({ label, metric }: { label: string; metric: EvaluationMetric | undefined }) { return <SummaryCard label={label} value={metric === undefined ? "暂无" : formatDuration(metric.value)} detail="本地评测运行耗时" />; }
