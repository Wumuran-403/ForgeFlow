import { z } from "zod";

import { AppError } from "../shared/errors.js";

const HostControlAuthorizationInputSchema = z
  .object({
    taskId: z.string().min(1),
    operation: z.enum(["cancel_set", "pause_set", "pause_clear"]),
    requestNonce: z.string().trim().min(1),
    controlActor: z.string().trim().min(1),
  })
  .strict();

export type RecoveryEvidenceHostControlOperation = z.infer<
  typeof HostControlAuthorizationInputSchema
>["operation"];

export type RecoveryEvidenceHostControlAuthorizationInput = z.input<
  typeof HostControlAuthorizationInputSchema
>;

export interface RecoveryEvidenceHostControlClaims {
  readonly taskId: string;
  readonly operation: RecoveryEvidenceHostControlOperation;
  readonly requestNonce: string;
  readonly controlActor: string;
}

declare const recoveryEvidenceHostControlBrand: unique symbol;

export interface RecoveryEvidenceHostControlAuthorization {
  readonly [recoveryEvidenceHostControlBrand]: true;
}

const hostControlAuthorizations = new WeakMap<
  object,
  Readonly<RecoveryEvidenceHostControlClaims>
>();

// Internal Host Control adapter only. Deliberately not exported from the
// recovery public barrel; ordinary services receive capabilities, not minting.
export function issueRecoveryEvidenceHostControlAuthorization(
  input: RecoveryEvidenceHostControlAuthorizationInput,
): RecoveryEvidenceHostControlAuthorization {
  const parsed = HostControlAuthorizationInputSchema.parse(input);
  const authorization = Object.freeze({}) as
    RecoveryEvidenceHostControlAuthorization;
  hostControlAuthorizations.set(
    authorization,
    Object.freeze({ ...parsed }),
  );
  return authorization;
}

export function assertRecoveryEvidenceHostControlAuthorization(
  authorization: unknown,
  expected: {
    readonly operation: RecoveryEvidenceHostControlOperation;
    readonly requestNonce?: string;
    readonly controlActor?: string;
  },
): Readonly<RecoveryEvidenceHostControlClaims> {
  if (
    authorization === null ||
    typeof authorization !== "object" ||
    !hostControlAuthorizations.has(authorization)
  ) {
    throw hostControlError();
  }
  const claims = hostControlAuthorizations.get(authorization)!;
  if (
    claims.operation !== expected.operation ||
    (expected.requestNonce !== undefined &&
      claims.requestNonce !== expected.requestNonce) ||
    (expected.controlActor !== undefined &&
      claims.controlActor !== expected.controlActor)
  ) {
    throw hostControlError();
  }
  return claims;
}

function hostControlError(): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_HOST_CONTROL_AUTHORIZATION_INVALID",
    message: "Recovery evidence host control authorization is invalid.",
    statusCode: 409,
    details: [],
  });
}
