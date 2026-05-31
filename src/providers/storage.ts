import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

export type StorageProvider = {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
};

const log = logger.child({ provider: "storage" });

class LocalStorage implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<string> {
    const filePath = join(this.root, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    const publicPath = `/audio/${key}`;
    log.debug({ filePath, publicPath }, "wrote audio to local storage");
    return publicPath;
  }
}

class S3Storage implements StorageProvider {
  constructor() {
    // CLAUDE.md §2.6: S3 path is intentionally unimplemented for the
    // technical-test scope. The interface is in place so prod wiring is a
    // localized change.
    throw new Error("S3Storage not implemented. Use LocalStorage in dev.");
  }

  async put(_key: string, _body: Buffer, _contentType: string): Promise<string> {
    throw new Error("S3Storage not implemented.");
  }
}

function makeStorageProvider(): StorageProvider {
  if (config.S3_BUCKET) {
    return new S3Storage();
  }
  return new LocalStorage("public/audio");
}

export const storageProvider: StorageProvider = makeStorageProvider();
