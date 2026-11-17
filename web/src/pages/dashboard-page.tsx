import { useState } from "react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Wrench,
  Network,
  Gauge,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import { zh } from "../lib/locale";
import { formatDate, formatDuration, formatNumber, formatRatio, truncate } from "../lib/format";
import type { DashboardData, ObservabilitySummary } from "../lib/types";
import { usePolling } from "../lib/use-polling";
import {
  Button,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
} from "../components/ui";

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [metrics, setMetrics] = useState<ObservabilitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const navigate = useNavigate();

  const load = async (): Promise<void> => {
    try {
      const [dashboard, summary] = await Promise.all([api.dashboard(), api.metrics()]);
      setData(dashboard);
      setMetrics(summary);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "概览加载失败。",
      );
    }
  };
  usePolling(load, 4_000);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="实时运行"
        title="任务执行概览"
        description="查看任务、审批队列与执行状态。"
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
              刷新
            </Button>
            <Button size="sm" onClick={() => navigate("/workspace")}>
              <Bot className="size-3.5" />
              新建任务
            </Button>
          </div>
        }
      />

      {error === null ? null : <ErrorNotice message={error} />}
      {data === null || metrics === null ? (
        <Panel className="p-5">
          <Spinner label="正在加载运行数据" />
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="任务总数"
              value={metrics.tasks.total}
              detail={`${data.stats.completedTasks} 个已完成`}
              icon={<ServerCog className="size-4" />}
            />
            <Metric
              label="任务成功率"
              value={formatRatio(metrics.ratios.taskSuccess.numerator, metrics.ratios.taskSuccess.denominator)}
              detail={`${metrics.ratios.taskSuccess.numerator} / ${metrics.ratios.taskSuccess.denominator || "暂无"} 个已结束任务`}
              icon={<Clock3 className="size-4" />}
              tone="teal"
            />
            <Metric
              label="已暂停"
              value={(metrics.tasks.byStatus.paused ?? 0) + (metrics.tasks.byStatus.pause_requested ?? 0)}
              detail={`${data.stats.pendingApprovals} 个等待审批`}
              icon={<ShieldAlert className="size-4" />}
              tone={(metrics.tasks.byStatus.paused ?? 0) > 0 ? "amber" : "neutral"}
            />
            <Metric
              label="失败"
              value={metrics.tasks.byStatus.failed ?? 0}
              detail={`${metrics.tasks.byStatus.cancelled ?? 0} 个已取消`}
              icon={<CheckCircle2 className="size-4" />}
              tone="green"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="工具调用" value={metrics.tools.total} detail={`${formatRatio(metrics.ratios.toolSuccess.numerator, metrics.ratios.toolSuccess.denominator)} 成功 · ${metrics.tools.failed} 次失败`} icon={<Wrench className="size-4" />} />
            <Metric label="MCP 调用" value={metrics.mcp.calls} detail={`${formatRatio(metrics.ratios.mcpSuccess.numerator, metrics.ratios.mcpSuccess.denominator)} 成功 · 来自实际执行记录`} icon={<Network className="size-4" />} tone="teal" />
            <Metric label="模型实际 Token" value={metrics.tokens.provider} detail="仅统计模型返回的用量" icon={<Gauge className="size-4" />} />
            <Metric label="估算 Token" value={metrics.tokens.estimated} detail={`${metrics.tokens.unknownCalls} 次调用用量未知`} icon={<Gauge className="size-4" />} />
          </div>

          <Panel className="p-5">
            <div className="grid gap-5 lg:grid-cols-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#7a8580]">执行耗时</div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <MiniStat label="平均" value={metrics.latency.completedTasks === 0 ? "暂无" : formatDuration(metrics.latency.averageMs)} />
                  <MiniStat label="P50" value={metrics.latency.completedTasks === 0 ? "暂无" : formatDuration(metrics.latency.p50Ms)} />
                  <MiniStat label="P95" value={metrics.latency.completedTasks === 0 ? "暂无" : formatDuration(metrics.latency.p95Ms)} />
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#7a8580]">循环保护</div>
                <div className="mt-3 text-2xl font-semibold tabular-nums text-[#26322e]">{metrics.loopGuard.detections}</div>
                <div className="mt-1 text-xs text-[#7a8580]">影响 {metrics.loopGuard.affectedTasks} 个任务</div>
                <div className="mt-2 flex flex-wrap gap-1">{Object.entries(metrics.loopGuard.byReason).length === 0 ? <span className="text-xs text-[#8a958f]">暂无循环记录</span> : Object.entries(metrics.loopGuard.byReason).map(([reason, count]) => <span key={reason} className="rounded-full bg-[#f1f4f2] px-2 py-1 text-[10px] text-[#52605a]">{zh(reason)} · {count}</span>)}</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#7a8580]">恢复结果</div>
                <div className="mt-3 text-2xl font-semibold text-[#26322e]">{formatRatio(metrics.ratios.recoverySuccess.numerator, metrics.ratios.recoverySuccess.denominator)}</div>
                <div className="mt-1 text-xs text-[#7a8580]">{metrics.recovery.successfulTasks} 个安全恢复 / {metrics.recovery.eligibleTasks || "暂无"} 个可恢复</div>
                <div className="mt-2 text-xs text-[#9a650c]">{metrics.recovery.unknownWriteTasks} 个写入结果未知的任务不计为成功</div>
              </div>
            </div>
          </Panel>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Panel className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#e3e8e5] px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-[#28342f]">
                    最近任务
                  </h2>
                  <p className="mt-0.5 text-xs text-[#7a8580]">
                    从数据库读取的任务状态
                  </p>
                </div>
                <Link
                  to="/history"
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#0f766e] hover:text-[#115e59]"
                >
                  查看历史
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>
              {data.recentTasks.length === 0 ? (
                <EmptyState
                  icon={<Bot className="size-5" />}
                  title="暂无任务"
                  description="在任务工作台创建任务后，这里会显示执行状态与工具记录。"
                  action={
                    <Button size="sm" onClick={() => navigate("/workspace")}>
                      打开工作台
                      <ArrowRight className="size-3.5" />
                    </Button>
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-[#e8ecea] bg-[#f8faf9] text-[11px] uppercase tracking-[0.08em] text-[#7a8580]">
                      <tr>
                        <th className="px-5 py-3 font-semibold">工作流</th>
                        <th className="px-4 py-3 font-semibold">状态</th>
                        <th className="px-4 py-3 font-semibold">工具</th>
                        <th className="px-4 py-3 font-semibold">Token</th>
                        <th className="px-4 py-3 font-semibold">保护</th>
                        <th className="px-5 py-3 font-semibold">创建时间</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#edf0ee]">
                      {data.recentTasks.map((task) => (
                        <tr
                          key={task.id}
                          className="cursor-pointer transition-colors hover:bg-[#f9fbfa]"
                          onClick={() => navigate(`/history?task=${task.id}`)}
                        >
                          <td className="px-5 py-4">
                            <div className="font-medium text-[#2b3732]">
                              {zh(task.workflowName)}
                            </div>
                            <div className="mt-1 max-w-md truncate text-xs text-[#7a8580]">
                              {truncate(zh(task.objective.split("\n")[0] ?? task.objective), 100)}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <StatusBadge status={task.status} />
                          </td>
                          <td className="px-4 py-4 tabular-nums text-[#52605a]">
                            {task.toolCalls}
                          </td>
                          <td className="px-4 py-4 tabular-nums text-[#52605a]">
                            <div>{formatNumber(task.tokenUsage.totalTokens)}</div>
                            <div className="mt-1 text-[10px] text-[#8a958f]">
                              实际 {formatNumber(task.tokenUsage.provider?.totalTokens)} · 估算 {formatNumber(task.tokenUsage.estimated?.totalTokens)}
                            </div>
                          </td>
                          <td className="px-4 py-4 text-xs text-[#52605a]">
                            {task.safeguards.loopGuardTriggered
                              ? "循环"
                              : task.safeguards.tokenBudgetExhausted
                                ? "预算"
                                : "—"}
                          </td>
                          <td className="px-5 py-4 text-xs text-[#6d7974]">
                            {formatDate(task.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <div className="space-y-4">
              <Panel className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                      运行环境
                    </div>
                    <div className="mt-2 text-xl font-semibold text-[#26322e]">
                      {data.provider.label}
                    </div>
                  </div>
                  <div className="flex size-10 items-center justify-center rounded-md bg-[#edf4f1] text-[#16685f]">
                    <ServerCog className="size-5" />
                  </div>
                </div>
                <dl className="mt-5 space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-[#7a8580]">模型来源</dt>
                    <dd className="font-medium uppercase text-[#35413c]">
                      {data.provider.kind}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-[#7a8580]">数据存储</dt>
                    <dd className="font-medium text-[#35413c]">SQLite</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-[#7a8580]">刷新间隔</dt>
                    <dd className="font-medium text-[#35413c]">4 秒</dd>
                  </div>
                </dl>
              </Panel>

              <Panel className="p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                  可用工作流
                </div>
                <div className="mt-3 space-y-3">
                  {data.workflows.map((workflow) => (
                    <div
                      key={workflow.id}
                      className="border-t border-[#edf0ee] pt-3 first:border-0 first:pt-0"
                    >
                      <div className="text-sm font-medium text-[#2d3934]">
                        {zh(workflow.name)}
                      </div>
                      <div className="mt-1 text-xs leading-5 text-[#7a8580]">
                        {zh(workflow.description)}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  detail: string;
  icon: React.ReactNode;
  tone?: "neutral" | "teal" | "amber" | "green";
}) {
  return (
    <Panel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-[#7a8580]">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-[#202c28]">
            {typeof value === "number" ? formatNumber(value) : value}
          </div>
        </div>
        <div
          className={
            tone === "teal"
              ? "flex size-9 items-center justify-center rounded-md bg-[#eaf6f2] text-[#0f766e]"
              : tone === "amber"
                ? "flex size-9 items-center justify-center rounded-md bg-[#fff5df] text-[#9a650c]"
                : tone === "green"
                  ? "flex size-9 items-center justify-center rounded-md bg-[#eef7f0] text-[#2f7440]"
                  : "flex size-9 items-center justify-center rounded-md bg-[#f0f3f1] text-[#5d6a65]"
          }
        >
          {icon}
        </div>
      </div>
      <div className="mt-3 text-xs text-[#7a8580]">{detail}</div>
    </Panel>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[#f6f8f7] px-3 py-2"><div className="text-[10px] uppercase tracking-[0.08em] text-[#8a958f]">{label}</div><div className="mt-1 text-sm font-semibold tabular-nums text-[#35413c]">{value}</div></div>;
}
