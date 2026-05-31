import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { storageProvider } from "@/providers/storage";

const PUBLIC_AUDIO = join(process.cwd(), "public/audio");

describe("storageProvider (local)", () => {
  beforeAll(async () => {
    await mkdir(PUBLIC_AUDIO, { recursive: true });
  });

  afterAll(async () => {
    await rm(PUBLIC_AUDIO, { recursive: true, force: true });
  });

  it("writes audio under public/audio and returns a public path", async () => {
    const buf = Buffer.from("stub-audio", "utf8");
    const url = await storageProvider.put("episodes/test.mp3", buf, "audio/mpeg");

    expect(url).toBe("/audio/episodes/test.mp3");
    const written = await readFile(join(PUBLIC_AUDIO, "episodes/test.mp3"));
    expect(written.toString()).toBe("stub-audio");
  });
});
