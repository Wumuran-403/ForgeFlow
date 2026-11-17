import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const InventorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(80),
    minimumAvailable: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const InventoryItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  available: z.number().int().nonnegative(),
  location: z.string(),
}).strict();

const InventorySearchOutputSchema = z.object({
  query: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(InventoryItemSchema),
}).strict();

const INVENTORY = [
  { sku: "STM32F407VGT6", name: "STM32F407 high-performance MCU", category: "mcu", available: 128, location: "A-01" },
  { sku: "STM32H743ZIT6", name: "STM32H743 Cortex-M7 MCU", category: "mcu", available: 42, location: "A-02" },
  { sku: "NUCLEO-F446RE", name: "STM32 Nucleo development board", category: "development-board", available: 17, location: "B-11" },
  { sku: "STLINK-V3SET", name: "ST-LINK debug probe", category: "debugger", available: 9, location: "C-07" },
] as const;

function createServer(): McpServer {
  const server = new McpServer({ name: "forgeflow-inventory-demo", version: "1.0.0" });
  server.registerTool(
    "inventory.search",
    {
      description: "Search deterministic demo inventory by SKU, name, or category.",
      inputSchema: InventorySearchInputSchema,
      outputSchema: InventorySearchOutputSchema,
    },
    ({ query, minimumAvailable, limit }) => {
      const needle = query.toLowerCase();
      const items = INVENTORY.filter((item) =>
        item.available >= minimumAvailable &&
        [item.sku, item.name, item.category].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      ).slice(0, limit).map((item) => ({ ...item }));
      const output = { query, count: items.length, items };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
  return server;
}

serveStdio(createServer, {
  onerror: (error) => {
    console.error(`ForgeFlow demo MCP server error: ${error.message}`);
  },
});
