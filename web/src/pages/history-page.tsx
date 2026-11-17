import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  FileClock,
  History,
  ListTree,
  RefreshCw,
  Search,
  Wrench,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { api } from "../lib/api";
import { BomResultSummary } from "../components/bom-result-summary";
import { zh } from "../lib/locale";
import { formatDate, formatNumber, prettyJson, truncate } from "../lib/format";
import type { TaskDetail, TaskSummary } from "../lib/types";
import { usePolling } from "../lib/use-polling";
import {
  Button,
  EmptyState,
  ErrorNotice,
  JsonBlock,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
  cn,
} from "../components/ui";

type DetailTab = "plan" | "tools" | "events" | "checkpoints" | "errors";

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("task");
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("plan");
  const [error, setError] = useState<string | null>(null);

  const loadTasks = async (): Promise<void> => {
    try {
      setTasks(await api.tasks());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "历史记录加载失败。",
      );
    }
  };
  const loadDetail = async (): Promise<void> => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.task(selectedId));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "任务详情加载失败。",
      );
    }
  };
  usePolling(loadTasks, 5_000);
  usePolling(loadDetail, 2_500, selectedId !== null);

  const filteredTasks = (tasks ?? []).filter((task) => {
    const normalized = query.trim().toLowerCase();
    return (
      normalized === "" ||
      task.workflowName.toLowerCase().includes(normalized) ||
      zh(task.workflowName).includes(normalized) ||
      task.objective.toLowerCase().includes(normalized) ||
      task.id.toLowerCase().includes(normalized)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="执行记录"
        title="执行历史"
        description="查看任务计划、工具运行、事件、检查点和失败详情。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void loadTasks();
              void loadDetail();
            }}
          >
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
        }
      />
      {error === null ? null : <ErrorNotice message={error} />}
      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel className="overflow-hidden">
          <div className="border-b border-[#e4e8e6] p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#8a958f]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务编号或工作流"
                className="h-9 w-full rounded-md border border-[#d6dcd8] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
              />
            </div>
          </div>
          {tasks === null ? (
            <div className="p-5">
              <Spinner label="正在加载任务历史" />
            </div>
          ) : filteredTasks.length === 0 ? (
            <EmptyState
              icon={<History className="size-5" />}
              title="没有匹配的任务"
              description="启动工作流后，执行记录会出现在这里。"
            />
          ) : (
            <div className="max-h-[720px] divide-y divide-[#edf0ee] overflow-y-auto">
              {filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSearchParams({ task: task.id })}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-4 text-left transition-colors",
                    selectedId === task.id ? "bg-[#eef5f2]" : "hover:bg-[#f9fbfa]",
                  )}
                >
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[#f0f3f1] text-[#5e6d66]">
                    <FileClock className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="truncate text-xs font-semibold text-[#34413c]">
                        {zh(task.workflowName)}
                      </div>
                      <ChevronRight className="size-3.5 shrink-0 text-[#8a958f]" />
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-[#74807b]">
                      {truncate(zh(task.objective.split("\n")[0] ?? task.objective), 90)}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StatusBadge status={task.status} />
                      <span className="text-[10px] text-[#8a958f]">
                        {formatDate(task.createdAt)}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="min-h-[650px] overflow-hidden">
          {selectedId === null ? (
            <EmptyState
              icon={<ListTree className="size-5" />}
              title="选择一个任务"
              description="选择任务后可查看计划与保存的执行记录。"
            />
          ) : detail === null ? (
            <div className="p-6">
              <Spinner label="正在加载执行详情" />
            </div>
          ) : (
            <div>
              <div className="border-b border-[#e4e8e6] px-5 py-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={detail.status} />
                  <span className="text-xs text-[#7a8580]">
                    {zh(detail.workflowName)}
                  </span>
                </div>
                <h2 className="mt-3 text-base font-semibold text-[#2b3732]">
                  {truncate(zh(detail.objective.split("\n")[0] ?? detail.objective), 180)}
                </h2>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#7a8580]">
                  <span className="font-mono">{detail.id}</span>
                  <span>创建于 {formatDate(detail.createdAt)}</span>
                </div>
              </div>
              {detail.workflowId === "stm32-bom-recovery" ? <div className="px-5 py-5"><BomResultSummary task={detail} /></div> : null}
              <div className="border-b border-[#e4e8e6] px-4 pt-3">
                <div className="flex gap-1 overflow-x-auto">
                  {[
                    { id: "plan", label: "计划", icon: ClipboardList },
                    { id: "tools", label: "工具记录", icon: Wrench },
                    { id: "events", label: "事件", icon: CalendarClock },
                    { id: "checkpoints", label: "检查点", icon: FileClock },
                    { id: "errors", label: "错误", icon: AlertTriangle },
                  ].map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTab(id as DetailTab)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium",
                        tab === id
                          ? "border-[#0f766e] text-[#0f6d64]"
                          : "border-transparent text-[#77837e] hover:text-[#35423d]",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-5">
                <DetailContent tab={tab} detail={detail} />
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function DetailContent({
  tab,
  detail,
}: {
  tab: DetailTab;
  detail: TaskDetail;
}) {
  if (tab === "plan") {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SmallMetric label="计划数" value={detail.plans.length} />
          <SmallMetric label="计划步骤" value={detail.planSteps.length} />
          <SmallMetric label="模型轮次" value={detail.modelCalls} />
          <SmallMetric label="模型实际 Token" value={detail.tokenUsage.provider?.totalTokens ?? 0} />
          <SmallMetric label="估算 Token" value={detail.tokenUsage.estimated?.totalTokens ?? 0} />
        </div>
        <div className="rounded-md border border-[#e1e6e3] bg-[#fafbfa] px-3 py-3 text-xs text-[#63706b]">
          Token 预算：{formatNumber(detail.tokenBudget.usedTokens)} / {detail.tokenBudget.maxTokens === null ? "不限" : formatNumber(detail.tokenBudget.maxTokens)}
          {detail.safeguards.loopGuardTriggered ? " · 循环保护已触发" : " · 循环保护正常"}
          {detail.safeguards.tokenBudgetExhausted ? " · 预算已耗尽" : ""}
        </div>
        {detail.modelCallDetails.length === 0 ? null : (
          <div className="overflow-x-auto rounded-md border border-[#e1e6e3]">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="border-b border-[#e8ecea] bg-[#fafbfa] text-[10px] uppercase tracking-[0.08em] text-[#7a8580]">
                <tr>
                  <th className="px-3 py-2 font-semibold">轮次</th>
                  <th className="px-3 py-2 font-semibold">状态</th>
                  <th className="px-3 py-2 font-semibold">用量来源</th>
                  <th className="px-3 py-2 font-semibold">输入</th>
                  <th className="px-3 py-2 font-semibold">输出</th>
                  <th className="px-3 py-2 font-semibold">总计</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf0ee]">
                {detail.modelCallDetails.map((call) => (
                  <tr key={call.iteration}>
                    <td className="px-3 py-2">{call.iteration}</td>
                    <td className="px-3 py-2">{zh(call.status)}</td>
                    <td className="px-3 py-2">{zh(call.usage?.source ?? "unknown")}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNumber(call.usage?.promptTokens)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNumber(call.usage?.completionTokens)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatNumber(call.usage?.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.plans.map((plan) => (
          <div key={plan.id} className="rounded-md border border-[#e1e6e3]">
            <div className="flex items-center justify-between border-b border-[#e8ecea] bg-[#fafbfa] px-3 py-2.5 text-xs">
              <span className="font-medium text-[#35423d]">
                第 {plan.version} 版计划
              </span>
              <span className="text-[#7a8580]">{zh(plan.status)}</span>
            </div>
            <div className="divide-y divide-[#edf0ee]">
              {detail.planSteps
                .filter((step) => step.planId === plan.id)
                .map((step) => (
                  <div
                    key={step.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs"
                  >
                    <span className="font-mono text-[#52605a]">
                      {step.stepIndex}. {zh(step.kind)}
                    </span>
                    <span className="text-[#35423d]">{zh(step.status)}</span>
                  </div>
                ))}
            </div>
          </div>
        ))}
        {detail.plans.length === 0 ? <NoData label="暂无计划记录。" /> : null}
      </div>
    );
  }
  if (tab === "tools") {
    return (
      <div className="space-y-3">
        {detail.toolRuns.map((run) => (
          <div key={run.id} className="rounded-md border border-[#e1e6e3]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8ecea] bg-[#fafbfa] px-3 py-2.5">
              <span className="font-mono text-xs font-medium text-[#35423d]">
                {run.toolName}
              </span>
              <span className="text-xs text-[#6a7671]">
                {zh(run.mode)} · {zh(run.status)}
              </span>
            </div>
            {run.toolName.startsWith("mcp_") ? (
              <div className="border-b border-[#dcebe7] bg-[#f3f9f7] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#0f6d64]">
                预设本地 MCP 连接 · 参数已验证 · 输出受限制
              </div>
            ) : null}
            <div className="grid gap-3 p-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                  输入
                </div>
                <JsonBlock value={run.input} maxHeight="12rem" />
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                  结果
                </div>
                <JsonBlock value={run.output ?? run.error} maxHeight="12rem" />
              </div>
            </div>
          </div>
        ))}
        {detail.toolRuns.length === 0 ? <NoData label="暂无工具记录。" /> : null}
      </div>
    );
  }
  if (tab === "events") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left text-xs">
          <thead className="border-b border-[#e3e8e5] text-[10px] uppercase tracking-[0.08em] text-[#7a8580]">
            <tr>
              <th className="px-2 py-2 font-semibold">序号</th>
              <th className="px-2 py-2 font-semibold">事件</th>
              <th className="px-2 py-2 font-semibold">对象</th>
              <th className="px-2 py-2 font-semibold">详情</th>
              <th className="px-2 py-2 font-semibold">时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#edf0ee]">
            {detail.events.map((event) => (
              <tr key={event.sequence}>
                <td className="px-2 py-2.5 font-mono text-[#8a958f]">
                  {event.sequence}
                </td>
                <td className="px-2 py-2.5 font-mono text-[#35423d]">
                  {event.type}
                </td>
                <td className="px-2 py-2.5 text-[#63706b]">
                  {event.entityType ?? "—"}
                </td>
                <td className="max-w-[28rem] px-2 py-2.5 text-[#63706b]">
                  {event.type === "loop_detected" || event.type === "token_budget_exhausted" || event.type === "global_model_budget_exhausted"
                    ? <JsonBlock value={event.payload} maxHeight="10rem" />
                    : "—"}
                </td>
                <td className="px-2 py-2.5 text-[#7a8580]">
                  {formatDate(event.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {detail.events.length === 0 ? <NoData label="暂无事件记录。" /> : null}
      </div>
    );
  }
  if (tab === "checkpoints") {
    return (
      <div className="space-y-2">
        {detail.checkpoints.map((checkpoint) => (
          <div
            key={checkpoint.sequence}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#e1e6e3] px-3 py-3 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[#8a958f]">
                #{checkpoint.sequence}
              </span>
              <span className="font-medium text-[#35423d]">
                {checkpoint.reason}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[#7a8580]">
              <span>{zh(checkpoint.taskStatus)}</span>
              <span>第 {checkpoint.modelIteration} 轮</span>
              <span>{formatDate(checkpoint.createdAt)}</span>
            </div>
          </div>
        ))}
        {detail.checkpoints.length === 0 ? (
          <NoData label="暂无检查点。" />
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {detail.error === null ? (
        <NoData label="暂无任务错误。" />
      ) : (
        <div className="rounded-md border border-[#f1c6c1] bg-[#fff7f6] p-4">
          <div className="font-mono text-xs font-semibold text-[#9f2f24]">
            {detail.error.code}
          </div>
          <div className="mt-1 text-sm text-[#7d3b34]">
            {detail.error.message}
          </div>
        </div>
      )}
      {detail.toolRuns
        .filter((run) => run.error !== null)
        .map((run) => (
          <div
            key={run.id}
            className="rounded-md border border-[#eadad7] bg-[#fffafa] p-3"
          >
            <div className="font-mono text-xs font-medium text-[#7d3b34]">
              {run.toolName}
            </div>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-5 text-[#6f4d48]">
              {prettyJson(run.error)}
            </pre>
          </div>
        ))}
    </div>
  );
}

function SmallMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-[#e1e6e3] bg-[#fafbfa] px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-[#2d3934]">
        {value}
      </div>
    </div>
  );
}

function NoData({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-[#d9e0dc] px-4 py-10 text-center text-xs text-[#7a8580]">
      {label}
    </div>
  );
}
