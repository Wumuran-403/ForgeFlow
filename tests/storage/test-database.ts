import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TemporaryDatabase {
  readonly directory: string;
  readonly path: string;
  cleanup(): void;
}

export function createTemporaryDatabase(): TemporaryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "forgeflow-sqlite-"));
  const path = join(directory, "forgeflow-test.db");
  let cleaned = false;

  return {
    directory,
    path,
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
