import { describe, expect, it } from "vitest";

import { AppError, toErrorResponse } from "../../src/shared/errors.js";

describe("toErrorResponse", () => {
  it("preserves public application details", () => {
    const response = toErrorResponse(
      new AppError({
        code: "INVALID_INPUT",
        message: "The request is invalid.",
        statusCode: 400,
        details: [{ path: "name", message: "Required" }],
      }),
      "request-1",
    );

    expect(response.error).toEqual({
      code: "INVALID_INPUT",
      message: "The request is invalid.",
      details: [{ path: "name", message: "Required" }],
    });
  });

  it("does not expose internal error messages", () => {
    const response = toErrorResponse(new Error("sensitive implementation detail"), "request-2");

    expect(response.error.code).toBe("INTERNAL_ERROR");
    expect(response.error.message).toBe("An internal error occurred.");
    expect(JSON.stringify(response)).not.toContain("sensitive implementation detail");
  });
});
