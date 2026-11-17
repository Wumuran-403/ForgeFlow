import { AppError } from "../shared/errors.js";

const issued = new WeakSet<object>();
declare const convergenceBrand: unique symbol;
export interface FinalConvergenceCapability { readonly [convergenceBrand]: true }

// Internal Final Decision UoW only. This issuer is deliberately absent from storage/index.
export function createFinalConvergenceCapability(): FinalConvergenceCapability {
  const capability = Object.freeze({}) as FinalConvergenceCapability;
  issued.add(capability);
  return capability;
}

export function assertFinalConvergenceCapability(value: unknown): asserts value is FinalConvergenceCapability {
  if (value === null || typeof value !== "object" || !issued.has(value)) {
    throw new AppError({ code: "RECOVERY_REVIEW_FINAL_CONVERGENCE_CAPABILITY_REQUIRED",
      message: "Final task convergence requires internal authorization.", statusCode: 403, details: [] });
  }
}
