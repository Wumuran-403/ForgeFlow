import {
  assertCanonicalJsonValue,
} from "../shared/canonical-json.js";
import {
  ToolAlreadyRegisteredError,
  ToolDefinitionInvalidError,
  ToolExecutionError,
  ToolInputValidationError,
  ToolNotFoundError,
  ToolRegistryLockedError,
  ToolValidatedInputInvalidError,
} from "./errors.js";
import { computeToolInputSchemaHash } from "./fingerprint.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  ToolMetadataSchema,
  ToolRegistrationOptionsSchema,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolRegistryExecutionLease,
  type RegisteredToolMetadata,
  type ValidatedToolInput,
} from "./types.js";

interface StoredTool {
  readonly metadata: RegisteredToolMetadata;
  run(
    input: unknown,
    context?: ToolExecutionContext,
  ): unknown | Promise<unknown>;
}

interface ValidatedInputRecord {
  readonly tool: StoredTool;
  readonly value: unknown;
}

interface InputParseFailure {
  path: string;
  message: string;
}

function toValidationDetails(
  issues: readonly InputParseFailure[],
): readonly InputParseFailure[] {
  return issues.map((issue) => ({
    path: issue.path || "input",
    message: issue.message,
  }));
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(value);
}

export class ToolRegistry {
  private readonly tools = new Map<string, StoredTool>();
  private readonly validatedInputs = new WeakMap<
    ValidatedToolInput,
    ValidatedInputRecord
  >();
  private activeExecutionLeases = 0;

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    this.assertMutable();

    const metadataResult = ToolMetadataSchema.safeParse({
      name: definition.name,
      description: definition.description,
      mode: definition.mode,
    });
    const optionsResult = ToolRegistrationOptionsSchema.safeParse({
      version: definition.version,
      timeoutMs: definition.timeoutMs,
      requiresApproval: definition.requiresApproval,
    });

    if (!metadataResult.success || !optionsResult.success) {
      const issues = [
        ...(metadataResult.success ? [] : metadataResult.error.issues),
        ...(optionsResult.success ? [] : optionsResult.error.issues),
      ];

      throw new ToolDefinitionInvalidError(
        definition.name,
        issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }

    const metadata = metadataResult.data;
    const options = optionsResult.data;
    if (this.tools.has(metadata.name)) {
      throw new ToolAlreadyRegisteredError(metadata.name);
    }

    let inputSchemaHash: string;
    try {
      inputSchemaHash = computeToolInputSchemaHash(definition.inputSchema);
    } catch {
      throw new ToolDefinitionInvalidError(metadata.name, [
        {
          path: "inputSchema",
          message: "Tool input schema must be representable as canonical JSON Schema.",
        },
      ]);
    }

    const registeredMetadata: RegisteredToolMetadata = Object.freeze({
      ...metadata,
      version: options.version ?? "1",
      inputSchema: definition.inputSchema,
      inputSchemaHash,
      timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      requiresApproval:
        options.requiresApproval ?? metadata.mode === "write",
    });

    this.tools.set(metadata.name, {
      metadata: registeredMetadata,
      run: (input: unknown, context?: ToolExecutionContext) =>
        definition.execute(input as TInput, context),
    });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredToolMetadata {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }

    return tool.metadata;
  }

  list(): readonly RegisteredToolMetadata[] {
    return Array.from(this.tools.values(), (tool) => tool.metadata);
  }

  unregister(name: string): void {
    this.assertMutable();

    if (!this.tools.delete(name)) {
      throw new ToolNotFoundError(name);
    }
  }

  acquireExecutionLease(): ToolRegistryExecutionLease {
    this.activeExecutionLeases += 1;
    let released = false;

    return Object.freeze({
      release: () => {
        if (released) {
          return;
        }

        released = true;
        this.activeExecutionLeases = Math.max(0, this.activeExecutionLeases - 1);
      },
    });
  }

  async validateInput(
    name: string,
    input: unknown,
  ): Promise<ValidatedToolInput> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new ToolNotFoundError(name);
    }

    const parsedInput = await tool.metadata.inputSchema.safeParseAsync(input);
    if (!parsedInput.success) {
      throw new ToolInputValidationError(
        name,
        toValidationDetails(
          parsedInput.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        ),
      );
    }

    try {
      assertCanonicalJsonValue(parsedInput.data);
    } catch {
      throw new ToolInputValidationError(name, [
        {
          path: "input",
          message: "Validated tool input must be JSON-compatible.",
        },
      ]);
    }

    let value: unknown;
    try {
      const serialized = JSON.stringify(parsedInput.data);
      if (serialized === undefined) {
        throw new TypeError("Validated tool input is not JSON-serializable.");
      }
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new ToolInputValidationError(name, [
        {
          path: "input",
          message: "Validated tool input must be JSON-compatible.",
        },
      ]);
    }

    deepFreeze(value);
    const validatedInput: ValidatedToolInput = Object.freeze({
      toolName: name,
      toolVersion: tool.metadata.version,
      inputSchemaHash: tool.metadata.inputSchemaHash,
      mode: tool.metadata.mode,
      timeoutMs: tool.metadata.timeoutMs,
      requiresApproval: tool.metadata.requiresApproval,
      value,
    });
    this.validatedInputs.set(validatedInput, {
      tool,
      value,
    });
    return validatedInput;
  }

  async execute<TOutput = unknown>(
    name: string,
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<TOutput> {
    const validatedInput = await this.validateInput(name, input);
    return this.executeValidated<TOutput>(validatedInput, context);
  }

  async executeValidated<TOutput = unknown>(
    validatedInput: ValidatedToolInput,
    context?: ToolExecutionContext,
  ): Promise<TOutput> {
    const record = this.validatedInputs.get(validatedInput);
    if (record === undefined) {
      throw new ToolValidatedInputInvalidError(validatedInput.toolName);
    }

    const tool = this.tools.get(validatedInput.toolName);
    if (tool !== record.tool) {
      throw new ToolValidatedInputInvalidError(validatedInput.toolName);
    }

    try {
      return (await record.tool.run(record.value, context)) as TOutput;
    } catch (error) {
      throw new ToolExecutionError(validatedInput.toolName, error);
    }
  }

  private assertMutable(): void {
    if (this.activeExecutionLeases > 0) {
      throw new ToolRegistryLockedError();
    }
  }
}
