import type { ToolCall } from "../provider/types.js";
import { ToolNotFoundError } from "../tools/errors.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  ToolModeSchema,
  type RegisteredToolMetadata,
  type ToolMode,
} from "../tools/types.js";
import type {
  PlannedKnownToolCall,
  PlannedUnknownToolCall,
  SchedulePlan,
  ScheduleStep,
} from "./types.js";

interface ValidMetadata {
  mode: ToolMode;
  timeoutMs: number;
  requiresApproval: boolean;
}

function toPlannedBase(
  toolCall: ToolCall,
  originalIndex: number,
): PlannedUnknownToolCall {
  return {
    originalIndex,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    arguments: toolCall.arguments,
  };
}

function readValidMetadata(
  metadata: RegisteredToolMetadata,
): ValidMetadata | undefined {
  const mode = ToolModeSchema.safeParse(metadata.mode);
  if (
    !mode.success ||
    !Number.isInteger(metadata.timeoutMs) ||
    metadata.timeoutMs <= 0 ||
    typeof metadata.requiresApproval !== "boolean"
  ) {
    return undefined;
  }

  return {
    mode: mode.data,
    timeoutMs: metadata.timeoutMs,
    requiresApproval: metadata.requiresApproval,
  };
}

export class TaskPlanner {
  constructor(readonly registry: ToolRegistry) {}

  plan(toolCalls: readonly ToolCall[]): SchedulePlan {
    const steps: ScheduleStep[] = [];
    let readBatch: PlannedKnownToolCall[] = [];

    const flushReadBatch = (): void => {
      if (readBatch.length === 0) {
        return;
      }

      steps.push({
        kind: "read_batch",
        items: readBatch,
      });
      readBatch = [];
    };

    for (const [originalIndex, toolCall] of toolCalls.entries()) {
      let metadata: RegisteredToolMetadata | undefined;
      let unknownReason: "not_registered" | "invalid_metadata" | undefined;

      try {
        metadata = this.registry.get(toolCall.name);
      } catch (error) {
        unknownReason =
          error instanceof ToolNotFoundError ? "not_registered" : "invalid_metadata";
      }

      if (metadata === undefined || metadata.name !== toolCall.name) {
        flushReadBatch();
        steps.push({
          kind: "unknown_tool",
          item: toPlannedBase(toolCall, originalIndex),
          reason: unknownReason ?? "invalid_metadata",
        });
        continue;
      }

      const safeMetadata = readValidMetadata(metadata);
      if (safeMetadata === undefined) {
        flushReadBatch();
        steps.push({
          kind: "unknown_tool",
          item: toPlannedBase(toolCall, originalIndex),
          reason: "invalid_metadata",
        });
        continue;
      }

      const plannedCall: PlannedKnownToolCall = {
        ...toPlannedBase(toolCall, originalIndex),
        ...safeMetadata,
      };

      if (safeMetadata.mode === "read") {
        readBatch.push(plannedCall);
        continue;
      }

      flushReadBatch();
      steps.push({
        kind: "write",
        item: plannedCall,
      });
    }

    flushReadBatch();
    return steps;
  }
}
