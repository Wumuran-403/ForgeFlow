import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { AppError } from "../shared/errors.js";

const STORE_REF_PREFIX = "evidence-file:sha256/";

export interface EvidencePayloadStoreResult {
  readonly storeRef: string;
  readonly storageMode: "content_addressed_file";
}

export interface EvidencePayloadStore {
  put(bytes: Uint8Array, expectedDigest: string): EvidencePayloadStoreResult;
  read(storeRef: string, expectedDigest: string): Uint8Array;
}

export class FileEvidencePayloadStore implements EvidencePayloadStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  put(
    bytes: Uint8Array,
    expectedDigest: string,
  ): EvidencePayloadStoreResult {
    const digestHex = digestHexFromRef(expectedDigest);
    if (sha256(bytes) !== expectedDigest) {
      throw new AppError({
        code: "EVIDENCE_PAYLOAD_DIGEST_MISMATCH",
        message: "Evidence payload content does not match its digest.",
        statusCode: 409,
        details: [],
      });
    }

    mkdirSync(this.rootDirectory, { recursive: true });
    const finalPath = join(this.rootDirectory, `${digestHex}.bin`);
    const tempPath = join(
      this.rootDirectory,
      `.tmp-${randomUUID()}-${digestHex}.bin`,
    );
    writeFileSync(tempPath, bytes, { flag: "wx" });
    try {
      linkSync(tempPath, finalPath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      this.read(storeRefFromDigest(expectedDigest), expectedDigest);
    } finally {
      rmSync(tempPath, { force: true });
    }
    return {
      storeRef: storeRefFromDigest(expectedDigest),
      storageMode: "content_addressed_file",
    };
  }

  read(storeRef: string, expectedDigest: string): Uint8Array {
    const digestHex = digestHexFromRef(expectedDigest);
    if (storeRef !== storeRefFromDigest(expectedDigest)) {
      throw new AppError({
        code: "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
        message: "Evidence payload store reference is invalid.",
        statusCode: 409,
        details: [],
      });
    }
    const path = join(this.rootDirectory, `${digestHex}.bin`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== expectedDigest) {
      throw new AppError({
        code: "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
        message: "Stored evidence payload no longer matches its digest.",
        statusCode: 409,
        details: [],
      });
    }
    return bytes;
  }
}

function digestHexFromRef(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new AppError({
      code: "EVIDENCE_PAYLOAD_DIGEST_INVALID",
      message: "Evidence payload digest is invalid.",
      statusCode: 409,
      details: [],
    });
  }
  return digest.slice("sha256:".length);
}

function storeRefFromDigest(digest: string): string {
  return `${STORE_REF_PREFIX}${digestHexFromRef(digest)}`;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
