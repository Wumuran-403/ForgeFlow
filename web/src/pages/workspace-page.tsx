import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  Braces,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  Play,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { api } from "../lib/api";
import { BomResultSummary } from "../components/bom-result-summary";
import { zh, zhReport } from "../lib/locale";
import { formatDate, truncate } from "../lib/format";
import type { TaskDetail, Workflow } from "../lib/types";
import { usePolling } from "../lib/use-polling";
import {
  Button,
  EmptyState,
  ErrorNotice,
  JsonBlock,
  PageHeader,
  Panel,
  Progress,
  Spinner,
  StatusBadge,
  cn,
} from "../components/ui";

const DEFAULT_QUANTITY = 2_000;

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get("task");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const [objective, setObjective] = useState("");
  const [buildQuantity, setBuildQuantity] = useState(String(DEFAULT_QUANTITY));
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .workflows()
      .then((values) => {
        if (!active) {
          return;
        }
        setWorkflows(values);
        const first = values[0];
        if (first !== undefined) {
          setSelectedWorkflow(first.id);
          setObjective(zh(first.defaultObjective ?? ""));
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "工作流加载失败。",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const loadTask = async (): Promise<void> => {
    if (taskId === null) {
      setTask(null);
      return;
    }
    try {
      setTask(await api.task(taskId));
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "任务加载失败。",
      );
    } finally {
      setLoadingTask(false);
    }
  };
  usePolling(loadTask, 1_500, taskId !== null);

  const chooseWorkflow = (workflow: Workflow): void => {
    setSelectedWorkflow(workflow.id);
    setObjective(zh(workflow.defaultObjective ?? ""));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.createTask({
        workflowId: selectedWorkflow,
        objective,
        buildQuantity: Number(buildQuantity),
      });
      setLoadingTask(true);
      setSearchParams({ task: created.id });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "任务创建失败。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const controlTask = async (action: "pause" | "resume" | "cancel"): Promise<void> => {
    if (taskId === null) return;
    setControlling(true);
    setError(null);
    try {
      await api.controlTask(taskId, action);
      setTask(await api.task(taskId));
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : "任务操作失败。");
    } finally {
      setControlling(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="智能体执行"
        title="任务工作台"
        description="创建任务、查看工具调用和实时执行进度。"
      />
      {error === null ? null : <ErrorNotice message={error} />}

      <div className="grid gap-6 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Panel className="self-start overflow-hidden">
          <div className="border-b border-[#e4e8e6] px-5 py-4">
            <h2 className="text-sm font-semibold text-[#2b3732]">新建任务</h2>
            <p className="mt-1 text-xs leading-5 text-[#7a8580]">
              选择工作流并填写目标，任务将在服务端运行。
            </p>
          </div>
          <form className="space-y-5 p-5" onSubmit={(event) => void submit(event)}>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#6f7b76]">
                工作流
              </div>
              <div className="space-y-2">
                {workflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    onClick={() => chooseWorkflow(workflow)}
                    className={cn(
                      "w-full rounded-md border p-3 text-left transition-colors",
                      selectedWorkflow === workflow.id
                        ? "border-[#13857c] bg-[#f0f8f5]"
                        : "border-[#dde3df] bg-white hover:border-[#b6c5bf]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[#2b3732]">
                        {zh(workflow.name)}
                      </span>
                      {selectedWorkflow === workflow.id ? (
                        <CheckCircle2 className="size-4 text-[#0f766e]" />
                      ) : null}
                    </div>
                    {workflow.category === "mcp" ? (
                      <div className="mt-2 inline-flex rounded-full border border-[#bfd9d3] bg-[#eff8f5] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#0f6d64]">
                        仅连接预设的本地 MCP 服务
                      </div>
                    ) : null}
                    <div className="mt-1 text-xs leading-5 text-[#77837e]">
                      {zh(workflow.description)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="build-quantity"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.1em] text-[#6f7b76]"
              >
                生产数量
              </label>
              <input
                id="build-quantity"
                type="number"
                min={1}
                max={100000}
                value={buildQuantity}
                onChange={(event) => setBuildQuantity(event.target.value)}
                className="h-10 w-full rounded-md border border-[#d6dcd8] bg-white px-3 text-sm outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
              />
            </div>

            <div>
              <label
                htmlFor="objective"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.1em] text-[#6f7b76]"
              >
                任务目标
              </label>
              <textarea
                id="objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                rows={7}
                className="w-full resize-y rounded-md border border-[#d6dcd8] bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-[#0f766e] focus:ring-2 focus:ring-[#0f766e]/10"
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={
                submitting ||
                selectedWorkflow === "" ||
                objective.trim().length < 10
              }
            >
              <Play className="size-4" />
              {submitting ? "正在启动..." : "开始执行"}
            </Button>
          </form>
        </Panel>

        <Panel className="min-h-[640px] overflow-hidden">
          {taskId === null ? (
            <EmptyState
              icon={<Bot className="size-5" />}
              title="尚未选择任务"
              description="创建工作流任务，或从执行历史打开已有任务。"
            />
          ) : task === null ? (
            <div className="p-6">
              <Spinner
                label={loadingTask ? "正在加载任务状态" : "正在等待任务状态"}
              />
            </div>
          ) : (
            <TaskWorkspace task={task} controlling={controlling} onControl={controlTask} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function TaskWorkspace({ task, controlling, onControl }: {
  task: TaskDetail;
  controlling: boolean;
  onControl(action: "pause" | "resume" | "cancel"): Promise<void>;
}) {
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const running =
    task.active || task.status === "running" || task.status === "queued";
  const canPause = task.active && task.persistedStatus === "running";
  const loopEvent = [...task.events].reverse().find((event) => event.type === "loop_detected");
  const budgetEvent = [...task.events].reverse().find((event) => event.type === "token_budget_exhausted");
  const globalBudgetEvent = [...task.events].reverse().find((event) => event.type === "global_model_budget_exhausted");
  const canResume = !task.active && loopEvent === undefined && budgetEvent === undefined && globalBudgetEvent === undefined && ["queued", "running", "paused", "waiting_approval"].includes(task.persistedStatus) && task.pendingApprovalCount === 0;
  const canCancel = !["completed", "failed", "cancelled", "waiting_review"].includes(task.persistedStatus);
  return (
    <div>
      <div className="border-b border-[#e4e8e6] px-5 py-5 sm:px-6">
        {loopEvent !== undefined ? (
          <div className="mb-4 rounded-md border border-[#e4bd91] bg-[#fff4e8] px-3 py-2 text-xs text-[#7b4b18]">
            循环保护已在下一次工具执行前暂停任务。请在执行历史查看循环事件；原因未解决前不能恢复。
          </div>
        ) : null}
        {budgetEvent !== undefined ? (
          <div className="mb-4 rounded-md border border-[#e4bd91] bg-[#fff4e8] px-3 py-2 text-xs text-[#7b4b18]">
            当前任务的 Token 预算已用尽，不会继续请求模型。你可以查看用量和事件记录，或取消任务。
          </div>
        ) : null}
        {globalBudgetEvent !== undefined ? (
          <div className="mb-4 rounded-md border border-[#e4bd91] bg-[#fff4e8] px-3 py-2 text-xs text-[#7b4b18]">
            全站模型预算或并发限制已阻止下一次付费请求。任务已安全暂停，可在执行历史查看记录。
          </div>
        ) : null}
        {task.persistedStatus === "waiting_review" || task.toolRuns.some((run) => run.status === "unknown") ? (
          <div className="mb-4 rounded-md border border-[#ecd49f] bg-[#fff8e8] px-3 py-2 text-xs text-[#855a0a]">
            写入结果无法确认，需要人工核对。当前网页暂不提供最终核对操作。
          </div>
        ) : null}
        {task.status === "interrupted" ? (
          <div className="mb-4 rounded-md border border-[#ecd49f] bg-[#fff8e8] px-3 py-2 text-xs text-[#855a0a]">
            执行曾中断。请先检查历史记录，确认状态后再恢复。
          </div>
        ) : null}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={task.status} />
              <span className="text-xs text-[#77837e]">
                {zh(task.workflowName)}
              </span>
            </div>
            <h2 className="mt-3 text-lg font-semibold tracking-[-0.01em] text-[#26322e]">
              {truncate(task.objective.split("\n")[0] ?? task.objective, 140)}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#7a8580]">
              <span>创建于 {formatDate(task.createdAt)}</span>
              <span className="font-mono">{task.id.slice(0, 8)}</span>
            </div>
          </div>
          {task.pendingApprovalCount > 0 ? (
            <Link
              to="/approvals"
              className="inline-flex items-center gap-2 rounded-md border border-[#ecd49f] bg-[#fff8e8] px-3 py-2 text-xs font-medium text-[#855a0a]"
            >
              <ShieldAlert className="size-3.5" />
              查看审批
              <ArrowRight className="size-3.5" />
            </Link>
          ) : null}
        </div>
        {canPause || canResume || canCancel ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {canPause ? <Button type="button" disabled={controlling} onClick={() => void onControl("pause")}>暂停</Button> : null}
            {canResume ? <Button type="button" disabled={controlling} onClick={() => void onControl("resume")}>恢复</Button> : null}
            {canCancel ? <Button type="button" disabled={controlling} onClick={() => void onControl("cancel")}>取消</Button> : null}
          </div>
        ) : null}
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Progress
            label="模型轮次"
            value={task.modelCalls}
            maximum={task.maxModelTurns}
          />
          <Progress
            label="工具调用"
            value={task.toolCalls}
            maximum={task.maxToolCalls}
          />
          {task.tokenBudget.maxTokens === null ? null : (
            <Progress
              label="任务 Token"
              value={task.tokenBudget.usedTokens}
              maximum={task.tokenBudget.maxTokens}
            />
          )}
        </div>
      </div>

      {task.workflowId === "stm32-bom-recovery" ? <div className="px-5 py-5 sm:px-6"><BomResultSummary task={task} /></div> : null}

      <div className="grid gap-0 divide-y divide-[#e7ebe9] lg:grid-cols-[minmax(0,1fr)_260px] lg:divide-x lg:divide-y-0">
        <div className="space-y-6 p-5 sm:p-6">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[#2b3732]">
                <TerminalSquare className="size-4 text-[#0f766e]" />
                工具执行记录
              </h3>
              <span className="text-xs tabular-nums text-[#7a8580]">
                已记录 {task.toolRuns.length} 次
              </span>
            </div>
            {task.toolRuns.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#d9e0dc] px-4 py-8 text-center text-xs text-[#7a8580]">
                {running ? "等待首次工具调用。" : "暂无工具调用记录。"}
              </div>
            ) : (
              <div className="space-y-2">
                {task.toolRuns.map((toolRun) => (
                  <div
                    key={toolRun.id}
                    className="rounded-md border border-[#e1e6e3] bg-[#fbfcfb]"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedTool(
                          expandedTool === toolRun.id ? null : toolRun.id,
                        )
                      }
                      className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        {toolRun.status === "succeeded" ? (
                          <CheckCircle2 className="size-4 shrink-0 text-[#2f7440]" />
                        ) : toolRun.status === "running" ? (
                          <CircleDashed className="size-4 shrink-0 animate-spin text-[#0f766e]" />
                        ) : (
                          <Braces className="size-4 shrink-0 text-[#7a8580]" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs font-medium text-[#2d3934]">
                            {toolRun.toolName}
                          </div>
                          <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#8a958f]">
                            {zh(toolRun.mode)} · {zh(toolRun.status)}
                          </div>
                          {toolRun.toolName.startsWith("mcp_") ? (
                            <div className="mt-1 text-[10px] font-medium text-[#0f766e]">
                              MCP 标准输入输出连接 · 预设服务 · 已检查输出大小
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <ArrowRight
                        className={cn(
                          "size-3.5 shrink-0 text-[#86918c] transition-transform",
                          expandedTool === toolRun.id ? "rotate-90" : "",
                        )}
                      />
                    </button>
                    {expandedTool === toolRun.id ? (
                      <div className="grid gap-3 border-t border-[#e8ecea] p-3 md:grid-cols-2">
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                            输入
                          </div>
                          <JsonBlock value={toolRun.input} maxHeight="12rem" />
                        </div>
                        <div>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                            输出
                          </div>
                          <JsonBlock
                            value={toolRun.output ?? toolRun.error}
                            maxHeight="12rem"
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#2b3732]">
              <ClipboardList className="size-4 text-[#0f766e]" />
              最终报告
            </h3>
            {task.finalAnswer === null ? (
              <div className="rounded-md border border-dashed border-[#d9e0dc] px-4 py-8 text-center text-xs text-[#7a8580]">
                {running ? "任务仍在执行。" : "暂无最终报告。"}
              </div>
            ) : task.workflowId === "stm32-bom-recovery" ? (
              <details className="rounded-md border border-[#dfe5e1] bg-[#fbfcfb] p-4 text-sm text-[#35423d]">
                <summary className="cursor-pointer font-medium">查看模型原始回答</summary>
                <p className="mt-2 text-xs text-[#7a8580]">模型文字可能未包含全部历史工具结果；物料数量与采购状态请以上方根据完整工具记录生成的核查结果为准。</p>
                <div className="mt-3 whitespace-pre-wrap leading-7">{zhReport(task.finalAnswer)}</div>
              </details>
            ) : (
              <div className="whitespace-pre-wrap rounded-md border border-[#dfe5e1] bg-[#fbfcfb] p-4 text-sm leading-7 text-[#35423d]">
                {zhReport(task.finalAnswer)}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-5 p-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
              执行状态
            </div>
            <dl className="mt-3 space-y-3 text-xs">
              <SummaryRow label="数据库状态" value={zh(task.persistedStatus)} />
              <SummaryRow
                label="任务租约"
                value={task.lease?.ownerId ?? "已释放"}
              />
              <SummaryRow
                label="隔离令牌"
                value={task.lease === null ? "—" : String(task.lease.fencingToken)}
              />
              <SummaryRow
                label="Token 总量"
                value={String(task.tokenUsage.totalTokens ?? 0)}
              />
              <SummaryRow
                label="模型实际"
                value={String(task.tokenUsage.provider?.totalTokens ?? 0)}
              />
              <SummaryRow
                label="估算用量"
                value={String(task.tokenUsage.estimated?.totalTokens ?? 0)}
              />
              <SummaryRow
                label="剩余额度"
                value={task.tokenBudget.remainingTokens === null ? "不限" : String(task.tokenBudget.remainingTokens)}
              />
              <SummaryRow
                label="循环保护"
                value={task.safeguards.loopGuardTriggered ? "已触发" : "正常"}
              />
            </dl>
          </div>
          <div className="border-t border-[#e5e9e7] pt-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
              模型轮次
            </div>
            <div className="mt-3 space-y-2">
              {task.modelCallDetails.map((call) => (
                <div
                  key={call.iteration}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-[#63706b]">第 {call.iteration} 轮</span>
                  <span className="text-right font-medium text-[#35423d]">
                    {zh(call.status)}
                    <span className="block text-[10px] font-normal text-[#8a958f]">
                      {zh(call.usage?.source ?? "unknown")} · {call.usage?.totalTokens ?? 0}
                    </span>
                  </span>
                </div>
              ))}
              {task.modelCallDetails.length === 0 ? (
                <div className="text-xs text-[#8a958f]">暂无模型调用。</div>
              ) : null}
            </div>
          </div>
          {task.error === null ? null : (
            <div className="border-t border-[#e5e9e7] pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#9f2f24]">
                错误
              </div>
              <div className="mt-2 text-xs leading-5 text-[#7d3b34]">
                {task.error.code}: {task.error.message}
              </div>
            </div>
          )}
          <Link
            to={`/history?task=${task.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#0f766e]"
          >
            Full execution history
            <ExternalLink className="size-3" />
          </Link>
        </aside>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-[#7a8580]">{label}</dt>
      <dd className="max-w-32 truncate font-mono text-[10px] text-[#35423d]">
        {value}
      </dd>
    </div>
  );
}
