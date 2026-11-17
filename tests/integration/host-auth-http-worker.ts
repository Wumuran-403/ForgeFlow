import { request } from "node:http";

import { z } from "zod";

const InputSchema = z
  .object({
    url: z.string().min(1),
    token: z.string().min(1),
    access: z.enum(["final_decision", "read_replay"]),
  })
  .strict();

const input = InputSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const url = new URL(
  `${input.url}/internal/recovery-review/authenticate`,
);
const body = JSON.stringify({ access: input.access });

const requestHandle = request(
  {
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  },
  (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      process.send?.({
        statusCode: response.statusCode ?? 0,
        body: JSON.parse(text) as unknown,
      }, () => process.exit(0));
    });
  },
);
requestHandle.on("error", () => {
  process.send?.({ error: "HTTP_WORKER_FAILED" }, () => process.exit(1));
});
requestHandle.end(body);
