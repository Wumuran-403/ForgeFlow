import type {
  Approval,
  DashboardData,
  Session,
  TaskDetail,
  TaskSummary,
  Workflow,
  ObservabilitySummary,
  EvaluationRun,
  EvaluationReport,
} from "./types";

interface ApiEnvelope<T> {
  data: T;
}

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Array<{ path: string; message: string }>;
  };
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      "x-forgeflow-client": "web",
      ...options.headers,
    },
  });
  const payload = (await response.json()) as
    | ApiEnvelope<T>
    | ApiErrorEnvelope;
  if (!response.ok) {
    const error = payload as ApiErrorEnvelope;
    throw new ApiError(
      error.error?.code ?? "WEB_REQUEST_FAILED",
      error.error?.message ?? "请求失败，请稍后重试。",
      response.status,
    );
  }
  return (payload as ApiEnvelope<T>).data;
}

export const api = {
  session(): Promise<Session> {
    return request("/api/auth/session");
  },
  dashboard(): Promise<DashboardData> {
    return request("/api/dashboard");
  },
  metrics(): Promise<ObservabilitySummary> {
    return request("/api/metrics/summary");
  },
  evaluations(limit = 50): Promise<EvaluationRun[]> {
    return request(`/api/evals?limit=${limit}`);
  },
  evaluation(runId: string): Promise<EvaluationReport> {
    return request(`/api/evals/${encodeURIComponent(runId)}`);
  },
  runEvaluation(): Promise<EvaluationRun> {
    return request("/api/evals/run", { method: "POST", body: JSON.stringify({}) });
  },
  workflows(): Promise<Workflow[]> {
    return request("/api/workflows");
  },
  tasks(limit = 50): Promise<TaskSummary[]> {
    return request(`/api/tasks?limit=${limit}`);
  },
  task(taskId: string): Promise<TaskDetail> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}`);
  },
  controlTask(taskId: string, action: "pause" | "resume" | "cancel"): Promise<TaskSummary> {
    return request(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  createTask(input: {
    workflowId: string;
    objective: string;
    buildQuantity: number;
  }): Promise<TaskSummary> {
    return request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  approvals(): Promise<Approval[]> {
    return request("/api/approvals");
  },
  decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<Approval> {
    return request(`/api/approvals/${approvalId}/${decision}`, {
      method: "POST",
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
  },
};
