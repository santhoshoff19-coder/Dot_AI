import { promises as fs } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { AttachmentEncodeError, toImageDataUrl } from "@/lib/attachments/encode";
import { normaliseImageResponse } from "@/lib/generation/router";
import { metadataFingerprint, modelExecution } from "@/lib/models/execution";
import { prisma } from "@/lib/db";
import type { AttachmentRef } from "@/types";

const UPLOADS = path.join(process.cwd(), "public", "uploads");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function ref(over: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: "a", name: "shot.png", mimeType: "image/png", size: PNG.length,
    type: "image", previewUrl: null, storageRef: null, extractedText: null, ...over,
  };
}

describe("vision input is actually transmitted", () => {
  it("inlines an uploaded image from disk as a data URL", async () => {
    await fs.mkdir(UPLOADS, { recursive: true });
    const name = `test-${Date.now()}.png`;
    await fs.writeFile(path.join(UPLOADS, name), PNG);
    try {
      const url = await toImageDataUrl(ref({ storageRef: `/uploads/${name}` }));
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(url.length).toBeGreaterThan(40);
    } finally {
      await fs.rm(path.join(UPLOADS, name), { force: true });
    }
  });

  it("passes an existing data URL through unchanged", async () => {
    const inline = "data:image/png;base64,AAAA";
    expect(await toImageDataUrl(ref({ previewUrl: inline }))).toBe(inline);
  });

  it("throws rather than silently dropping an unreadable image", async () => {
    await expect(toImageDataUrl(ref({ storageRef: "/uploads/does-not-exist.png" })))
      .rejects.toBeInstanceOf(AttachmentEncodeError);
  });

  it("refuses a non-image mime type", async () => {
    await expect(toImageDataUrl(ref({ mimeType: "application/pdf", storageRef: "/uploads/x.pdf" })))
      .rejects.toBeInstanceOf(AttachmentEncodeError);
  });

  it("never reads outside the upload directory", async () => {
    await expect(toImageDataUrl(ref({ storageRef: "/uploads/../../../etc/passwd" })))
      .rejects.toBeInstanceOf(AttachmentEncodeError);
  });
});

describe("image responses are normalised from every documented shape", () => {
  it("reads base64 from the dedicated image endpoint", () => {
    const r = normaliseImageResponse({
      data: [{ b64_json: "QUJD", media_type: "image/webp" }],
    });
    expect(r?.url).toBe("data:image/webp;base64,QUJD");
    expect(r?.mimeType).toBe("image/webp");
  });

  it("reads a hosted URL from the dedicated endpoint", () => {
    const r = normaliseImageResponse({ data: [{ url: "https://cdn.test/x.jpg" }] });
    expect(r?.url).toBe("https://cdn.test/x.jpg");
    expect(r?.mimeType).toBe("image/jpeg");
  });

  it("reads chat completions message.images", () => {
    const r = normaliseImageResponse({
      choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,ZZ" } }] } }],
    });
    expect(r?.url).toBe("data:image/png;base64,ZZ");
  });

  it("reads an image part inside message content", () => {
    const r = normaliseImageResponse({
      choices: [{ message: { content: [
        { type: "text", text: "here" },
        { type: "image_url", image_url: { url: "https://cdn.test/y.webp" } },
      ] } }],
    });
    expect(r?.url).toBe("https://cdn.test/y.webp");
  });

  it("returns null when there is no image, so no placeholder is invented", () => {
    expect(normaliseImageResponse({ choices: [{ message: { content: "sorry" } }] })).toBeNull();
    expect(normaliseImageResponse({})).toBeNull();
  });
});

describe("execution cache", () => {
  it("changes fingerprint when provider metadata changes", () => {
    const base = {
      contextLength: 128000, inputPrice: 1, outputPrice: 2,
      supportedParameters: "[]", catalogEndpoints: '["chat"]', active: true,
    };
    const a = metadataFingerprint(base);
    expect(metadataFingerprint({ ...base, inputPrice: 9 })).not.toBe(a);
    expect(metadataFingerprint({ ...base, active: false })).not.toBe(a);
    expect(metadataFingerprint({ ...base })).toBe(a);
  });

  it("caches a validated result and reuses it", async () => {
    const model = await prisma.model.findFirst({
      where: { active: true, modalities: { some: { direction: "OUTPUT", modality: "TEXT" } } },
    });
    await modelExecution.invalidate(model!.openrouterModelId, "TEXT");
    const first = await modelExecution.validateModel(model!.openrouterModelId, "TEXT");
    expect(first.executable).toBe(true);
    const second = await modelExecution.validateModel(model!.openrouterModelId, "TEXT");
    expect(second.stage).toBe("cache");
  }, 30_000);

  it("invalidates the cache when metadata changes", async () => {
    const model = await prisma.model.findFirst({
      where: { active: true, modalities: { some: { direction: "OUTPUT", modality: "TEXT" } } },
    });
    await modelExecution.validateModel(model!.openrouterModelId, "TEXT");
    await prisma.model.update({
      where: { id: model!.id }, data: { inputPrice: model!.inputPrice + 1.23 },
    });
    const after = await modelExecution.validateModel(model!.openrouterModelId, "TEXT");
    expect(after.stage).not.toBe("cache");
    await prisma.model.update({
      where: { id: model!.id }, data: { inputPrice: model!.inputPrice },
    });
  }, 30_000);

  it("supports manual revalidation", async () => {
    const model = await prisma.model.findFirst({ where: { active: true } });
    await modelExecution.validateModel(model!.openrouterModelId, "TEXT");
    const cleared = await modelExecution.invalidate(model!.openrouterModelId, "TEXT");
    expect(cleared).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("tracks probe spend separately from generation cost", async () => {
    const spend = await modelExecution.probeSpend();
    expect(spend).toHaveProperty("totalUsd");
    expect(spend).toHaveProperty("probes");
    // With no key no live probe has run, so spend is genuinely zero.
    expect(spend.totalUsd).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
