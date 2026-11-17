import { readFileSync } from "node:fs";

import { AppError } from "../shared/errors.js";
import {
  HostAuthenticationConfigV1Schema,
  type HostAuthenticationConfigV1,
} from "./host-authentication-config.js";

export function loadHostAuthenticationConfigFromFile(
  path: string,
): HostAuthenticationConfigV1 {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw configError();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configError();
  }
  try {
    return HostAuthenticationConfigV1Schema.parse(value);
  } catch {
    throw configError();
  }
}

function configError(): AppError {
  return new AppError({
    code: "HOST_AUTHENTICATION_CONFIG_INVALID",
    message: "Host authentication configuration is invalid.",
    statusCode: 500,
    details: [],
  });
}
