import { z } from "zod";

import {
  createMockStm32AuditProvider,
  createMockStm32DemoProvider,
  STM32_DEMO_SYSTEM_PROMPT,
} from "../demo/stm32-agent-demo.js";
import { MockLLMProvider } from "../provider/mock-provider.js";
import type { LLMProvider } from "../provider/types.js";

export const WORKFLOW_IDS = ["stm32-bom-recovery", "stm32-inventory-audit", "stm32-mcp-inventory-audit"] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export const WorkflowIdSchema = z.enum(WORKFLOW_IDS);

export interface WorkflowDefinition {
  readonly id: WorkflowId;
  readonly name: string;
  readonly description: string;
  readonly category: "supply-chain" | "analysis" | "mcp";
  readonly defaultObjective: string;
  readonly systemPrompt: string;
}

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  {
    id: "stm32-bom-recovery",
    name: "STM32 BOM Recovery",
    description:
      "Inspect BOM and stock, identify shortages, and create an approval-gated simulated procurement draft.",
    category: "supply-chain",
    defaultObjective:
      "Check the STM32F103C8T6 development-board BOM for 2,000 boards, identify shortages, and create a simulated procurement draft when required.",
    systemPrompt: STM32_DEMO_SYSTEM_PROMPT,
  },
  {
    id: "stm32-inventory-audit",
    name: "STM32 Inventory Audit",
    description:
      "Read the BOM and simulated inventory, calculate shortages, and produce a read-only readiness report.",
    category: "analysis",
    defaultObjective:
      "Audit the STM32F103C8T6 BOM and simulated inventory for 2,000 boards without performing any write.",
    systemPrompt: [
      STM32_DEMO_SYSTEM_PROMPT,
      "This workflow is read-only; do not call procurement_create_draft.",
    ].join(" "),
  },
  {
    id: "stm32-mcp-inventory-audit",
    name: "STM32 MCP Inventory Audit",
    description:
      "Query the allowlisted local MCP inventory server through a real stdio connection and persisted Scheduler path.",
    category: "mcp",
    defaultObjective:
      "Search the allowlisted MCP demo inventory for STM32 parts and report available stock without performing any write.",
    systemPrompt: [
      STM32_DEMO_SYSTEM_PROMPT,
      "Use only the namespaced MCP inventory tool. This workflow is read-only.",
    ].join(" "),
  },
];

export function getWorkflow(id: WorkflowId): WorkflowDefinition {
  const workflow = WORKFLOWS.find((candidate) => candidate.id === id);
  if (workflow === undefined) {
    throw new Error(`Unknown workflow: ${id}`);
  }
  return workflow;
}

export function buildWorkflowObjective(
  workflowId: WorkflowId,
  userObjective: string,
  buildQuantity: number,
): string {
  if (workflowId === "stm32-mcp-inventory-audit") {
    return [
      userObjective,
      `Reference build quantity: ${buildQuantity} boards.`,
      "Call mcp_inventory_inventory_search with query STM32, minimumAvailable 1, and limit 10.",
      "Use only the returned MCP inventory data and do not request any write.",
      "Finish with a concise availability summary and identify that the source is the local allowlisted MCP server.",
    ].join("\n");
  }
  if (workflowId === "stm32-inventory-audit") {
    return [
      userObjective,
      `Build quantity: ${buildQuantity} boards.`,
      "Call bom_get_items and inventory_lookup for every BOM line.",
      "Calculate shortages using requiredQuantity = per-board BOM quantity multiplied by the build quantity.",
      "Do not call procurement_create_draft or any other write tool.",
      "Finish with a concise inventory and shortage report based only on tool output.",
    ].join("\n");
  }
  return [
    userObjective,
    `Build quantity: ${buildQuantity} boards.`,
    "Call bom_get_items and inventory_lookup for every BOM line.",
    "Calculate shortages using requiredQuantity = per-board BOM quantity multiplied by the build quantity.",
    "If shortages exist, call procurement_create_draft exactly once with the shortfall items. The write requires approval.",
    "Call procurement_get_drafts to confirm the simulated draft state after the approval result.",
    "Finish with shortages, lead times, recommendations, approval outcome, and draft confirmation.",
    "Do not invent stock, prices, suppliers, or external side effects.",
  ].join("\n");
}

export function createWorkflowMockProvider(
  workflowId: WorkflowId,
  buildQuantity: number,
  completedToolTurns = 0,
): LLMProvider {
  if (workflowId === "stm32-mcp-inventory-audit") {
    const provider = new MockLLMProvider([
      {
        content: "Querying the allowlisted MCP inventory server.",
        toolCalls: [{
          id: "web-mcp-inventory-search",
          name: "mcp_inventory_inventory_search",
          arguments: { query: "STM32", minimumAvailable: 1, limit: 10 },
        }],
      },
      "The allowlisted local MCP inventory query completed. The persisted ToolRun contains the verified structured inventory result.",
    ]);
    provider.skipResponses(Math.min(completedToolTurns, 1));
    return provider;
  }
  return workflowId === "stm32-inventory-audit"
    ? createMockStm32AuditProvider({ buildQuantity, completedToolTurns })
    : createMockStm32DemoProvider({ buildQuantity, completedToolTurns });
}
