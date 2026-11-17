import { randomUUID } from "node:crypto";

import type { AgentRunResult } from "../agent/types.js";
import { PersistenceCoordinator } from "../persistence/index.js";
import {
  MockLLMProvider,
  type MockProviderResponse,
} from "../provider/mock-provider.js";
import {
  ModelResponseSchema,
  type GenerateOptions,
  type LLMProvider,
  type ModelRequest,
  type ModelResponse,
} from "../provider/types.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
  type WriteApprovalHandler,
} from "../scheduler/index.js";
import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type TaskSnapshot,
} from "../storage/index.js";
import {
  createStm32DemoRuntime,
  STM32_TOOL_NAMES,
  type Stm32ProcurementDraft,
} from "../tools/demo/stm32.js";

export const STM32_DEMO_SYSTEM_PROMPT = [
  "You are ForgeFlow, a cautious hardware supply-chain agent.",
  "Use only tool results as evidence.",
  "Writes are allowed only through the registered approval-gated procurement draft tool.",
  "When procurement_create_draft succeeds, its output explicitly records approval='approved'; do not claim the approval is missing.",
  "Never claim that a draft exists unless procurement_get_drafts confirms it.",
].join(" ");

export const STM32_DEMO_OBJECTIVE = [
  "Check the STM32F103C8T6 development-board BOM for a build of 2,000 boards.",
  "Follow this workflow:",
  "1. Call bom_get_items and inspect every BOM line.",
  "2. Call inventory_lookup for every BOM line, using requiredQuantity equal to the per-board quantity multiplied by 2,000.",
  "3. Identify every shortage and propose procurement or substitution actions.",
  "4. If there is at least one shortage, call procurement_create_draft exactly once with the shortage items. This is a simulated write and will require approval.",
  "5. Call procurement_get_drafts to re-read and confirm the persisted draft state, even if approval was rejected.",
  "6. Finish with a concise report that states shortages, lead times, recommendations, approval outcome from the write result, and final draft confirmation.",
  "Do not invent stock, prices, suppliers, or external side effects.",
].join("\n");

export interface Stm32AgentDemoOptions {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly approvalHandler: WriteApprovalHandler;
  readonly taskId?: string;
  readonly ownerId?: string;
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly approvalTimeoutMs?: number;
  readonly readConcurrency?: number;
  readonly signal?: AbortSignal;
}

export interface Stm32AgentDemoResult {
  readonly run: AgentRunResult;
  readonly snapshot: TaskSnapshot;
  readonly drafts: readonly Stm32ProcurementDraft[];
}

export async function runStm32AgentDemo(
  options: Stm32AgentDemoOptions,
): Promise<Stm32AgentDemoResult> {
  const database = openDatabase(":memory:");
  try {
    migrateStorage(database);
    const runtime = createStm32DemoRuntime();
    const taskId = options.taskId ?? `stm32-demo-${randomUUID()}`;
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: STM32_DEMO_OBJECTIVE,
      systemPrompt: STM32_DEMO_SYSTEM_PROMPT,
      maxModelTurns: options.maxModelTurns ?? 10,
      maxToolCalls: options.maxToolCalls ?? 24,
    });

    const planner = new TaskPlanner(runtime.registry);
    const scheduler = new TaskScheduler({
      registry: runtime.registry,
      planner,
      readWorkerPool: new ReadWorkerPool(runtime.registry, {
        maxConcurrency: options.readConcurrency ?? 4,
      }),
      writeExecutor: new WriteExecutor(runtime.registry, {
        approvalHandler: options.approvalHandler,
        approvalTimeoutMs: options.approvalTimeoutMs ?? 120_000,
      }),
    });
    const coordinator = new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider: options.provider,
      registry: runtime.registry,
      scheduler,
      model: options.model,
    });
    const run = await coordinator.run(
      taskId,
      options.ownerId ?? `stm32-demo-owner-${randomUUID()}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const snapshot = new TaskSnapshotReader(database).load(taskId);
    return {
      run,
      snapshot,
      drafts: runtime.drafts,
    };
  } finally {
    closeDatabase(database);
  }
}

export function createMockStm32DemoProvider(options?: {
  readonly buildQuantity?: number;
  readonly completedToolTurns?: number;
}): LLMProvider {
  return new Stm32MockLLMProvider(options?.buildQuantity ?? 2_000, options?.completedToolTurns ?? 0);
}

export function createMockStm32AuditProvider(options?: {
  readonly buildQuantity?: number;
  readonly completedToolTurns?: number;
}): LLMProvider {
  return new Stm32MockAuditProvider(options?.buildQuantity ?? 2_000, options?.completedToolTurns ?? 0);
}

class Stm32MockLLMProvider implements LLMProvider {
  private readonly buildQuantity: number;
  private readonly toolTurns: MockLLMProvider;
  private readonly toolTurnCount: number;

  constructor(buildQuantity: number, completedToolTurns: number) {
    this.buildQuantity = buildQuantity;
    const inventoryCalls = createInventoryToolCalls(buildQuantity);
    const shortages = calculateMockShortages(buildQuantity);
    const turns = [
    {
      content: "Inspecting the STM32F103C8T6 BOM.",
      toolCalls: [
        {
          id: "demo-call-bom",
          name: STM32_TOOL_NAMES.bomGetItems,
          arguments: {},
        },
      ],
    },
    {
      content: `Checking inventory for every BOM line at ${buildQuantity.toLocaleString("en-US")} boards.`,
      toolCalls: inventoryCalls,
    },
    ...(shortages.length === 0
      ? []
      : [{
      content: "Creating a simulated procurement draft for the shortfalls.",
      toolCalls: [
        {
          id: "demo-call-create-draft",
          name: STM32_TOOL_NAMES.procurementCreateDraft,
          arguments: {
            items: shortages,
          },
        },
      ],
    }]),
    {
      content: "Re-reading the simulated procurement drafts.",
      toolCalls: [
        {
          id: "demo-call-read-drafts",
          name: STM32_TOOL_NAMES.procurementGetDrafts,
          arguments: {},
        },
      ],
    },
    ] satisfies ConstructorParameters<typeof MockLLMProvider>[0];
    this.toolTurns = new MockLLMProvider(turns);
    this.toolTurns.skipResponses(Math.min(completedToolTurns, turns.length));
    this.toolTurnCount = turns.length;
  }

  async generate(
    request: ModelRequest,
    options: GenerateOptions = {},
  ): Promise<ModelResponse> {
    if (this.toolTurns.consumedResponseCount < this.toolTurnCount) {
      return this.toolTurns.generate(request, options);
    }

    return createMockResponse(
      buildMockFinalAnswer(request.messages, this.buildQuantity, true),
    );
  }
}

class Stm32MockAuditProvider implements LLMProvider {
  private readonly buildQuantity: number;
  private readonly toolTurns: MockLLMProvider;

  constructor(buildQuantity: number, completedToolTurns: number) {
    this.buildQuantity = buildQuantity;
    this.toolTurns = new MockLLMProvider([
      {
        content: "Inspecting the STM32F103C8T6 BOM.",
        toolCalls: [
          {
            id: "audit-call-bom",
            name: STM32_TOOL_NAMES.bomGetItems,
            arguments: {},
          },
        ],
      },
      {
        content: "Checking inventory for every BOM line.",
        toolCalls: createInventoryToolCalls(buildQuantity, "audit"),
      },
    ]);
    this.toolTurns.skipResponses(Math.min(completedToolTurns, 2));
  }

  async generate(
    request: ModelRequest,
    options: GenerateOptions = {},
  ): Promise<ModelResponse> {
    if (this.toolTurns.consumedResponseCount < 2) {
      return this.toolTurns.generate(request, options);
    }
    return createMockResponse(
      buildMockFinalAnswer(request.messages, this.buildQuantity, false),
    );
  }
}

function buildMockFinalAnswer(
  messages: ModelRequest["messages"],
  buildQuantity: number,
  includeWriteOutcome: boolean,
): string {
  const toolResults = messages.flatMap((message) => {
    if (message.role !== "tool") {
      return [];
    }
    try {
      const parsed = JSON.parse(message.content) as {
        toolName?: unknown;
        status?: unknown;
        output?: unknown;
      };
      return [parsed];
    } catch {
      return [];
    }
  });
  const bom = toolResults.find(
    (result) => result.toolName === STM32_TOOL_NAMES.bomGetItems,
  )?.output;
  const inventoryByPart = new Map<string, {
    readonly available: number;
    readonly leadTimeDays: number;
  }>();
  for (const result of toolResults) {
    if (
      result.toolName !== STM32_TOOL_NAMES.inventoryLookup ||
      typeof result.output !== "object" ||
      result.output === null
    ) {
      continue;
    }
    const output = result.output as {
      partNumber?: unknown;
      available?: unknown;
      leadTimeDays?: unknown;
    };
    if (
      typeof output.partNumber === "string" &&
      typeof output.available === "number" &&
      typeof output.leadTimeDays === "number"
    ) {
      inventoryByPart.set(output.partNumber, {
        available: output.available,
        leadTimeDays: output.leadTimeDays,
      });
    }
  }
  const lines =
    typeof bom === "object" &&
    bom !== null &&
    "lines" in bom &&
    Array.isArray(bom.lines)
      ? bom.lines
      : [];
  const shortages = lines.flatMap((line) => {
    if (typeof line !== "object" || line === null) {
      return [];
    }
    const candidate = line as {
      partNumber?: unknown;
      quantity?: unknown;
    };
    if (
      typeof candidate.partNumber !== "string" ||
      typeof candidate.quantity !== "number"
    ) {
      return [];
    }
    const inventory = inventoryByPart.get(candidate.partNumber);
    if (inventory === undefined) {
      return [];
    }
    const required = candidate.quantity * buildQuantity;
    const shortage = Math.max(0, required - inventory.available);
    return shortage > 0
      ? [{
          partNumber: candidate.partNumber,
          required,
          available: inventory.available,
          shortage,
          leadTimeDays: inventory.leadTimeDays,
        }]
      : [];
  });
  const shortageLines =
    shortages.length === 0
      ? ["- No inventory shortages were found."]
      : shortages.map(
          (item) =>
            `- ${item.partNumber}: required ${item.required}, available ${item.available}, short ${item.shortage}; ${item.leadTimeDays}-day demo lead time.`,
        );
  const writeStatus = toolResults.find(
    (result) => result.toolName === STM32_TOOL_NAMES.procurementCreateDraft,
  )?.status;
  const readResult = toolResults.findLast(
    (result) => result.toolName === STM32_TOOL_NAMES.procurementGetDrafts,
  )?.output;
  const draftCount =
    typeof readResult === "object" &&
    readResult !== null &&
    "count" in readResult &&
    typeof readResult.count === "number"
      ? readResult.count
      : null;
  const writeSummary =
    writeStatus === "succeeded"
      ? "- The simulated procurement write succeeded."
      : writeStatus === "skipped"
        ? "- Procurement approval was rejected, so the simulated write was skipped."
        : "- The simulated procurement write did not report success.";
  const readSummary =
    draftCount === null
      ? "- Draft re-read did not return a confirmed count."
      : `- Re-reading confirmed ${draftCount} simulated procurement draft(s).`;
  return [
    `STM32F103C8T6 BOM readiness report for ${buildQuantity.toLocaleString("en-US")} boards:`,
    ...shortageLines,
    ...(includeWriteOutcome ? [writeSummary, readSummary] : []),
    "- No external inventory or procurement system was contacted.",
  ].join("\n");
}

function createMockResponse(content: string): ModelResponse {
  const promptTokens = 1;
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));
  return ModelResponseSchema.parse({
    message: {
      role: "assistant",
      content,
    },
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      source: "estimated",
    },
    finishReason: "stop",
    requestId: "mock-request-final",
  });
}

function createInventoryToolCalls(
  buildQuantity: number,
  prefix = "demo",
): NonNullable<MockProviderResponse["toolCalls"]> {
  return [
    {
      id: `${prefix}-call-stock-mcu`,
      name: STM32_TOOL_NAMES.inventoryLookup,
      arguments: {
        partNumber: "STM32F103C8T6",
        requiredQuantity: buildQuantity,
      },
    },
    {
      id: `${prefix}-call-stock-cap`,
      name: STM32_TOOL_NAMES.inventoryLookup,
      arguments: {
        partNumber: "CL10B104KB8NNNC",
        requiredQuantity: buildQuantity * 2,
      },
    },
    {
      id: `${prefix}-call-stock-resistor`,
      name: STM32_TOOL_NAMES.inventoryLookup,
      arguments: {
        partNumber: "RC0603FR-0710KL",
        requiredQuantity: buildQuantity,
      },
    },
    {
      id: `${prefix}-call-stock-crystal`,
      name: STM32_TOOL_NAMES.inventoryLookup,
      arguments: {
        partNumber: "X32258MSB4SI",
        requiredQuantity: buildQuantity,
      },
    },
  ];
}

function calculateMockShortages(
  buildQuantity: number,
): readonly {
  readonly partNumber: string;
  readonly quantity: number;
  readonly reason: string;
}[] {
  return [
    {
      partNumber: "STM32F103C8T6",
      required: buildQuantity,
      available: 1_050,
      leadTimeDays: 7,
    },
    {
      partNumber: "X32258MSB4SI",
      required: buildQuantity,
      available: 400,
      leadTimeDays: 12,
    },
  ].flatMap((item) => {
    const shortage = item.required - item.available;
    return shortage <= 0
      ? []
      : [{
          partNumber: item.partNumber,
          quantity: shortage,
          reason: `Required ${item.required}, available ${item.available}; source ${shortage} more units (${item.leadTimeDays}-day lead time).`,
        }];
  });
}
