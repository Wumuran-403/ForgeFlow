import { z } from "zod";

import type { TaskDetail } from "./types.js";

const bomOutput = z.object({
  lines: z.array(z.object({
    partNumber: z.string().min(1),
    designator: z.string().optional(),
  }).passthrough()),
}).passthrough();

const inventoryOutput = z.object({
  partNumber: z.string().min(1),
  requiredQuantity: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().nonnegative().optional(),
}).passthrough();

const draftOutput = z.object({
  draft: z.object({ id: z.string().min(1) }).passthrough(),
}).passthrough();
const readbackOutput = z.object({
  drafts: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

export interface ShortageRow {
  partNumber: string;
  displayName: string;
  designator: string | null;
  required: number;
  available: number;
  shortage: number;
  leadTimeDays: number | null;
}

const demoPartNames: Record<string, string> = {
  STM32F103C8T6: "STM32 主控芯片",
  X32258MSB4SI: "8 MHz 晶振",
  CL10B104KB8NNNC: "陶瓷电容",
  "RC0603FR-0710KL": "电阻",
};

export interface BomSummary {
  checkedCount: number;
  expectedCount: number | null;
  complete: boolean;
  shortages: ShortageRow[];
  draft: "not_requested" | "waiting_approval" | "created" | "rejected" | "unknown" | "failed";
  draftId: string | null;
  readbackConfirmed: boolean;
}

export function deriveBomSummary(task: TaskDetail): BomSummary | null {
  if (task.workflowId !== "stm32-bom-recovery") return null;

  const bomRun = task.toolRuns.find((run) => run.toolName === "bom_get_items" && run.status === "succeeded");
  const bom = bomOutput.safeParse(bomRun?.output);
  const expectedParts = bom.success
    ? new Map(bom.data.lines.map((line) => [line.partNumber, line.designator ?? null]))
    : null;
  const inventory = new Map<string, ShortageRow>();
  for (const run of task.toolRuns) {
    if (run.toolName !== "inventory_lookup" || run.status !== "succeeded") continue;
    const parsed = inventoryOutput.safeParse(run.output);
    if (!parsed.success) continue;
    const item = parsed.data;
    if (expectedParts !== null && !expectedParts.has(item.partNumber)) continue;
    inventory.set(item.partNumber, {
      partNumber: item.partNumber,
      displayName: demoPartNames[item.partNumber] ?? item.partNumber,
      designator: expectedParts?.get(item.partNumber) ?? null,
      required: item.requiredQuantity,
      available: item.available,
      shortage: Math.max(0, item.requiredQuantity - item.available),
      leadTimeDays: item.leadTimeDays ?? null,
    });
  }

  const write = task.toolRuns.find((run) => run.toolName === "procurement_create_draft");
  let draft: BomSummary["draft"] = "not_requested";
  let draftId: string | null = null;
  if (write !== undefined) {
    if (write.status === "unknown") draft = "unknown";
    else if (write.status === "awaiting_approval" || write.status === "queued" || write.status === "running") draft = "waiting_approval";
    else if (write.status === "succeeded") {
      const parsed = draftOutput.safeParse(write.output);
      if (parsed.success) {
        draft = "created";
        draftId = parsed.data.draft.id;
      } else draft = "unknown";
    } else if (task.approvals.some((approval) => approval.toolName === "procurement_create_draft" && approval.status === "rejected")) draft = "rejected";
    else draft = "failed";
  }
  const readback = task.toolRuns.find((run) => run.toolName === "procurement_get_drafts" && run.status === "succeeded");
  const parsedReadback = readbackOutput.safeParse(readback?.output);
  const readbackConfirmed = draftId !== null && parsedReadback.success &&
    parsedReadback.data.drafts.some((item) => item.id === draftId);

  return {
    checkedCount: inventory.size,
    expectedCount: expectedParts?.size ?? null,
    complete: expectedParts !== null && expectedParts.size > 0 && [...expectedParts.keys()].every((part) => inventory.has(part)),
    shortages: [...inventory.values()].filter((item) => item.shortage > 0),
    draft,
    draftId,
    readbackConfirmed,
  };
}
