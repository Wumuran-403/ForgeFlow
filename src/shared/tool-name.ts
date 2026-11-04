import { z } from "zod";

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    TOOL_NAME_PATTERN,
    "Tool names must use lowercase snake_case and must not contain dots.",
  );
