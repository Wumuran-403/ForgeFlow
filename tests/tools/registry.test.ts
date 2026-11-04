import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ToolAlreadyRegisteredError,
  ToolExecutionError,
  ToolInputValidationError,
  ToolNotFoundError,
  ToolDefinitionInvalidError,
  ToolRegistryLockedError,
  ToolValidatedInputInvalidError,
} from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../../src/tools/types.js";

const searchInputSchema = z
  .object({
    query: z.string().trim().min(2),
    limit: z.number().int().positive(),
  })
  .strict();

function createSearchTool(
  execute: ToolDefinition<z.infer<typeof searchInputSchema>, string[]>["execute"],
): ToolDefinition<z.infer<typeof searchInputSchema>, string[]> {
  return {
    name: "inventory_search",
    description: "Search demo inventory.",
    mode: "read",
    inputSchema: searchInputSchema,
    execute,
  };
}

describe("ToolRegistry", () => {
  it("registers, queries, lists, unregisters, and executes a tool", async () => {
    const execute = vi.fn(async ({ query, limit }: z.infer<typeof searchInputSchema>) => [
      `${query}:${limit}`,
    ]);
    const registry = new ToolRegistry();
    const tool = createSearchTool(execute);

    registry.register(tool);

    expect(registry.has("inventory_search")).toBe(true);
    expect(registry.get("inventory_search")).toMatchObject({
      name: "inventory_search",
      description: "Search demo inventory.",
      mode: "read",
    });
    expect(registry.get("inventory_search").inputSchema).toBe(searchInputSchema);
    expect(registry.list()).toHaveLength(1);
    await expect(
      registry.execute("inventory_search", { query: "STM32", limit: 2 }),
    ).resolves.toEqual(["STM32:2"]);
    expect(execute).toHaveBeenCalledOnce();

    registry.unregister("inventory_search");
    expect(registry.has("inventory_search")).toBe(false);
    expect(() => registry.get("inventory_search")).toThrow(ToolNotFoundError);
  });

  it("rejects duplicate, dotted, and missing tool registrations", () => {
    const registry = new ToolRegistry();
    const tool = createSearchTool(async () => []);

    registry.register(tool);

    expect(() => registry.register(tool)).toThrow(ToolAlreadyRegisteredError);
    expect(() =>
      registry.register({
        ...tool,
        name: "inventory.search",
      }),
    ).toThrow(ToolDefinitionInvalidError);
    expect(() => registry.unregister("missing_tool")).toThrow(ToolNotFoundError);
  });

  it("blocks invalid input before invoking the tool function", async () => {
    const execute = vi.fn(async () => ["unexpected"]);
    const registry = new ToolRegistry();
    registry.register(createSearchTool(execute));

    await expect(
      registry.execute("inventory_search", { query: "", limit: 0 }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("wraps tool execution failures without exposing the internal message", async () => {
    const registry = new ToolRegistry();
    const internalError = new Error("private tool implementation detail");
    registry.register(
      createSearchTool(async () => {
        throw internalError;
      }),
    );

    await expect(
      registry.execute("inventory_search", { query: "STM32", limit: 2 }),
    ).rejects.toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      cause: internalError,
    });
    await expect(
      registry.execute("inventory_search", { query: "STM32", limit: 2 }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("applies mode-based approval and timeout defaults", () => {
    const registry = new ToolRegistry();
    const readTool = createSearchTool(async () => []);
    const writeTool: ToolDefinition<z.infer<typeof searchInputSchema>, string[]> = {
      ...readTool,
      name: "inventory_update",
      mode: "write",
    };

    registry.register(readTool);
    registry.register(writeTool);

    expect(registry.get("inventory_search")).toMatchObject({
      requiresApproval: false,
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
    expect(registry.get("inventory_update")).toMatchObject({
      requiresApproval: true,
      timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it("accepts explicit approval and timeout values", () => {
    const registry = new ToolRegistry();
    const readTool: ToolDefinition<z.infer<typeof searchInputSchema>, string[]> = {
      ...createSearchTool(async () => []),
      requiresApproval: true,
      timeoutMs: 250,
    };
    const writeTool: ToolDefinition<z.infer<typeof searchInputSchema>, string[]> = {
      ...createSearchTool(async () => []),
      name: "inventory_update",
      mode: "write",
      requiresApproval: false,
      timeoutMs: 500,
    };

    registry.register(readTool);
    registry.register(writeTool);

    expect(registry.get("inventory_search")).toMatchObject({
      requiresApproval: true,
      timeoutMs: 250,
    });
    expect(registry.get("inventory_update")).toMatchObject({
      requiresApproval: false,
      timeoutMs: 500,
    });
  });

  it("rejects invalid timeout values", () => {
    const registry = new ToolRegistry();

    for (const [index, timeoutMs] of [0, -1, 1.5, Number.NaN].entries()) {
      expect(() =>
        registry.register({
          ...createSearchTool(async () => []),
          name: `invalid_timeout_${index}`,
          timeoutMs,
        }),
      ).toThrow(ToolDefinitionInvalidError);
    }
  });

  it("passes ToolExecutionContext to tool execution", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const context: ToolExecutionContext = {
      taskId: "task-context",
      toolCallId: "call-context",
      signal: controller.signal,
    };
    let receivedContext: ToolExecutionContext | undefined;
    registry.register({
      ...createSearchTool(async () => []),
      execute: (_input, executionContext) => {
        receivedContext = executionContext;
        return ["context"];
      },
    });

    await expect(
      registry.execute(
        "inventory_search",
        { query: "STM32", limit: 1 },
        context,
      ),
    ).resolves.toEqual(["context"]);
    expect(receivedContext).toBe(context);
  });

  it("prevalidates a cloned immutable input without executing the tool", async () => {
    const execute = vi.fn(async () => ["unexpected"]);
    const schema = z
      .object({
        query: z.string().min(2),
        filters: z
          .object({
            limit: z.number().int().positive(),
          })
          .strict(),
      })
      .strict();
    const registry = new ToolRegistry();
    registry.register({
      name: "inventory_prevalidate",
      description: "Validate an inventory request without running it.",
      mode: "write",
      inputSchema: schema,
      timeoutMs: 100,
      execute,
    });
    const source = { query: "STM32", filters: { limit: 2 } };

    const prepared = await registry.validateInput("inventory_prevalidate", source);
    source.filters.limit = 99;

    expect(prepared).toMatchObject({
      toolName: "inventory_prevalidate",
      mode: "write",
      timeoutMs: 100,
      requiresApproval: true,
      value: { query: "STM32", filters: { limit: 2 } },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.value)).toBe(true);
    expect(
      Object.isFrozen((prepared.value as { filters: { limit: number } }).filters),
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    await expect(
      registry.validateInput("inventory_prevalidate", {
        query: "S",
        filters: { limit: 0 },
      }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs Zod transforms and async refinements once across validation and execution", async () => {
    const transform = vi.fn((value: string) => value.trim().toUpperCase());
    const asyncRefinement = vi.fn(async (value: string) => value.length > 2);
    const registry = new ToolRegistry();
    let receivedInput: string | undefined;
    registry.register({
      name: "inventory_normalize",
      description: "Normalize an inventory identifier.",
      mode: "write",
      inputSchema: z
        .string()
        .transform(transform)
        .refine(asyncRefinement),
      execute: (input) => {
        receivedInput = input;
        return { input };
      },
    });

    const prepared = await registry.validateInput(
      "inventory_normalize",
      "  stm32  ",
    );
    expect(prepared.value).toBe("STM32");
    expect(transform).toHaveBeenCalledTimes(1);
    expect(asyncRefinement).toHaveBeenCalledTimes(1);

    await expect(registry.executeValidated(prepared)).resolves.toEqual({
      input: "STM32",
    });
    expect(receivedInput).toBe(prepared.value);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(asyncRefinement).toHaveBeenCalledTimes(1);
  });

  it("rejects a validated input after its tool definition is replaced", async () => {
    const registry = new ToolRegistry();
    const tool = createSearchTool(async () => ["old"]);
    registry.register(tool);
    const prepared = await registry.validateInput("inventory_search", {
      query: "STM32",
      limit: 1,
    });

    registry.unregister("inventory_search");
    registry.register({
      ...tool,
      execute: async () => ["replacement"],
    });

    await expect(registry.executeValidated(prepared)).rejects.toBeInstanceOf(
      ToolValidatedInputInvalidError,
    );
  });

  it("rejects non-JSON inputs without invoking tools or leaking details", async () => {
    const execute = vi.fn(async () => ["unexpected"]);
    const registry = new ToolRegistry();
    registry.register({
      name: "inventory_unknown_input",
      description: "Accept any input for JSON boundary testing.",
      mode: "read",
      inputSchema: z.unknown(),
      execute,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const input of [1n, circular, Number.NaN, new Date("2026-01-01")]) {
      let caughtError: unknown;
      try {
        await registry.validateInput("inventory_unknown_input", input);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(ToolInputValidationError);
      expect((caughtError as Error).message).not.toContain("BigInt");
      expect((caughtError as Error).message).not.toContain("circular");
      expect((caughtError as Error).message).not.toContain("Date");
      expect(JSON.stringify(caughtError)).not.toContain("BigInt");
    }

    expect(execute).not.toHaveBeenCalled();
  });

  it("locks registration and unregistration during an execution lease", () => {
    const registry = new ToolRegistry();
    const tool = createSearchTool(async () => []);
    registry.register(tool);
    const lease = registry.acquireExecutionLease();

    expect(() =>
      registry.register({
        ...tool,
        name: "inventory_other",
      }),
    ).toThrow(ToolRegistryLockedError);
    expect(() => registry.unregister("inventory_search")).toThrow(
      ToolRegistryLockedError,
    );

    lease.release();
    lease.release();
    expect(() => registry.unregister("inventory_search")).not.toThrow();
    expect(() =>
      registry.register({
        ...tool,
        name: "inventory_replacement",
      }),
    ).not.toThrow();
  });
});
