export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled"
  | "error"
  | "interrupted"
  | "pause_requested"
  | "paused"
  | "cancel_requested";

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated" | "unknown";
}

export interface TokenUsageAggregate {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: ModelUsage["source"] | "mixed";
  provider?: Omit<ModelUsage, "source">;
  estimated?: Omit<ModelUsage, "source">;
  providerCalls?: number;
  estimatedCalls?: number;
  unknownCalls?: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  category?: string;
  defaultObjective?: string;
}

export interface TaskSummary {
  id: string;
  objective: string;
  workflowId: string;
  workflowName: string;
  status: TaskStatus;
  persistedStatus: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  active: boolean;
  pendingApprovalCount: number;
  modelCalls: number;
  maxModelTurns: number;
  toolCalls: number;
  maxToolCalls: number;
  tokenUsage: TokenUsageAggregate;
  tokenBudget: {
    maxTokens: number | null;
    usedTokens: number;
    remainingTokens: number | null;
    exhausted: boolean;
  };
  safeguards: {
    loopGuardTriggered: boolean;
    tokenBudgetExhausted: boolean;
    globalModelBudgetExhausted: boolean;
  };
  finalAnswer: string | null;
  error: { code: string; message: string } | null;
}

export interface Approval {
  id: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  input: unknown;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface TaskDetail extends TaskSummary {
  messages: Array<{
    sequence: number;
    role: string;
    content: string;
    toolCallId: string | null;
  }>;
  modelCallDetails: Array<{
    iteration: number;
    status: string;
    finishReason: string | null;
    durationMs: number | null;
    usage: ModelUsage | null;
  }>;
  plans: Array<{
    id: string;
    version: number;
    status: string;
    createdAt: string;
  }>;
  planSteps: Array<{
    id: string;
    planId: string;
    stepIndex: number;
    kind: string;
    status: string;
  }>;
  toolRuns: Array<{
    id: string;
    toolCallId: string;
    toolName: string;
    mode: string;
    status: string;
    input: unknown;
    output: unknown;
    error: unknown;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  events: Array<{
    sequence: number;
    type: string;
    entityType: string | null;
    entityId: string | null;
    payload: unknown;
    createdAt: string;
  }>;
  checkpoints: Array<{
    sequence: number;
    reason: string;
    taskStatus: string;
    modelIteration: number;
    createdAt: string;
  }>;
  approvals: Approval[];
  lease: {
    ownerId: string | null;
    fencingToken: number;
    expiresAt: string | null;
    heartbeatAt: string;
  } | null;
}

export interface DashboardData {
  stats: {
    totalTasks: number;
    activeTasks: number;
    pendingApprovals: number;
    completedTasks: number;
    failedTasks: number;
  };
  recentTasks: TaskSummary[];
  provider: {
    kind: "mock" | "deepseek";
    label: string;
  };
  workflows: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

export interface RatioValue {
  numerator: number;
  denominator: number;
}

export interface ObservabilitySummary {
  tasks: { total: number; byStatus: Record<string, number> };
  tools: { total: number; failed: number; byStatus: Record<string, number> };
  tokens: { provider: number; estimated: number; unknownCalls: number };
  latency: { completedTasks: number; averageMs: number; p50Ms: number; p95Ms: number };
  loopGuard: { detections: number; affectedTasks: number; byReason: Record<string, number> };
  recovery: { eligibleTasks: number; successfulTasks: number; unknownWriteTasks: number };
  mcp: { calls: number; succeeded: number; failed: number };
  evaluations: { runs: number; completed: number; failed: number };
  ratios: {
    taskSuccess: RatioValue;
    toolSuccess: RatioValue;
    recoverySuccess: RatioValue;
    mcpSuccess: RatioValue;
  };
}

export interface EvaluationMetric {
  name: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
  unit: "ratio" | "milliseconds" | "tokens" | "count";
  exclusions: number;
  definition: string;
}

export interface EvaluationRun {
  id: string;
  suiteVersion: string;
  providerId: string;
  configVersion: string;
  status: "running" | "completed" | "failed";
  caseCount: number;
  passedCount: number | null;
  aggregate: null | {
    caseCount: number;
    passedCount: number;
    failedCount: number;
    metrics: EvaluationMetric[];
  };
  startedAt: string;
  finishedAt: string | null;
}

export interface EvaluationCaseResult {
  caseId: string;
  category: string;
  status: "passed" | "failed" | "error";
  expected: unknown;
  observation: unknown;
  verdict: {
    passed: boolean;
    reasons: string[];
    correctToolCalls: number;
    expectedToolCalls: number;
    unexpectedToolCalls: number;
  };
  latencyMs: number;
  error: { code: string; message: string } | null;
}

export interface EvaluationReport {
  run: EvaluationRun;
  cases: EvaluationCaseResult[];
}

export interface Session {
  actorId: string;
  kind: "guest";
  capabilities: {
    runEvaluation: boolean;
  };
}
