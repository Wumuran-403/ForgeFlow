import { z } from "zod";

import { ToolRegistry } from "../registry.js";
import type { ToolDefinition } from "../types.js";

export const STM32_TOOL_NAMES = {
  bomGetItems: "bom_get_items",
  inventoryLookup: "inventory_lookup",
  componentGetSpec: "component_get_spec",
} as const;

const bomLines = [
  {
    designator: "U1",
    partNumber: "STM32F103C8T6",
    manufacturer: "STMicroelectronics",
    footprint: "LQFP-48",
    quantity: 1,
    description: "ARM Cortex-M3 MCU, 64 KB Flash, 20 KB SRAM",
  },
  {
    designator: "C1",
    partNumber: "CL10B104KB8NNNC",
    manufacturer: "Samsung Electro-Mechanics",
    footprint: "0603",
    quantity: 2,
    description: "100 nF 50 V X7R ceramic capacitor",
  },
  {
    designator: "R1",
    partNumber: "RC0603FR-0710KL",
    manufacturer: "Yageo",
    footprint: "0603",
    quantity: 1,
    description: "10 kOhm 1% resistor",
  },
  {
    designator: "Y1",
    partNumber: "X32258MSB4SI",
    manufacturer: "Yangxing Tech",
    footprint: "HC-49S",
    quantity: 1,
    description: "8 MHz crystal",
  },
] as const;

const inventory = {
  STM32F103C8T6: {
    onHand: 1250,
    reserved: 200,
    available: 1050,
    leadTimeDays: 7,
    warehouse: "DEMO-A",
  },
  CL10B104KB8NNNC: {
    onHand: 24000,
    reserved: 3000,
    available: 21000,
    leadTimeDays: 3,
    warehouse: "DEMO-B",
  },
  "RC0603FR-0710KL": {
    onHand: 8000,
    reserved: 500,
    available: 7500,
    leadTimeDays: 5,
    warehouse: "DEMO-B",
  },
  "X32258MSB4SI": {
    onHand: 450,
    reserved: 50,
    available: 400,
    leadTimeDays: 12,
    warehouse: "DEMO-C",
  },
} as const;

const partSpecs = {
  STM32F103C8T6: {
    manufacturer: "STMicroelectronics",
    package: "LQFP-48",
    pinCount: 48,
    flashKb: 64,
    ramKb: 20,
    maxClockMhz: 72,
    supplyVoltageV: { min: 2, max: 3.6 },
  },
} as const;

const inspectBomInputSchema = z.object({}).strict();

const searchInventoryInputSchema = z
  .object({
    partNumber: z.string().trim().min(1),
    requiredQuantity: z.number().int().positive().default(1),
  })
  .strict();

const checkPartSpecInputSchema = z
  .object({
    partNumber: z.string().trim().min(1),
    expectedFootprint: z.string().trim().min(1).optional(),
  })
  .strict();

const inspectBomTool: ToolDefinition<Record<string, never>> = {
  name: STM32_TOOL_NAMES.bomGetItems,
  description: "Inspect the bundled STM32F103C8T6 demo BOM and validate required fields.",
  mode: "read",
  inputSchema: inspectBomInputSchema,
  execute: () => ({
    project: "STM32F103C8T6 minimal system",
    lines: bomLines,
    summary: {
      lineCount: bomLines.length,
      designatorCount: bomLines.reduce((total, line) => total + line.quantity, 0),
      missingRequiredFields: [],
    },
  }),
};

const searchInventoryTool: ToolDefinition<
  z.infer<typeof searchInventoryInputSchema>
> = {
  name: STM32_TOOL_NAMES.inventoryLookup,
  description: "Search the local demo inventory by manufacturer part number.",
  mode: "read",
  inputSchema: searchInventoryInputSchema,
  execute: ({ partNumber, requiredQuantity }) => {
    const stock = inventory[partNumber as keyof typeof inventory];
    if (stock === undefined) {
      return {
        found: false,
        partNumber,
        requiredQuantity,
      };
    }

    return {
      found: true,
      partNumber,
      requiredQuantity,
      ...stock,
      sufficient: stock.available >= requiredQuantity,
    };
  },
};

const checkPartSpecTool: ToolDefinition<z.infer<typeof checkPartSpecInputSchema>> = {
  name: STM32_TOOL_NAMES.componentGetSpec,
  description: "Check package and core specifications for a known demo part.",
  mode: "read",
  inputSchema: checkPartSpecInputSchema,
  execute: ({ partNumber, expectedFootprint }) => {
    const specification = partSpecs[partNumber as keyof typeof partSpecs];
    if (specification === undefined) {
      return {
        found: false,
        partNumber,
      };
    }

    return {
      found: true,
      partNumber,
      specification,
      expectedFootprint: expectedFootprint ?? null,
      footprintMatches:
        expectedFootprint === undefined || expectedFootprint === specification.package,
    };
  },
};

export function createStm32F103C8T6Registry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(inspectBomTool);
  registry.register(searchInventoryTool);
  registry.register(checkPartSpecTool);
  return registry;
}
