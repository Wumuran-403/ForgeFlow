import { spawn, type ChildProcess } from "node:child_process";

const children: ChildProcess[] = [
  spawn("pnpm dev:api", {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn("pnpm dev:ui", {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];

let stopping = false;
const stop = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) {
  child.once("exit", (code) => {
    if (!stopping && code !== 0) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
