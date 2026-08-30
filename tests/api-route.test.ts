import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as routePOST } from "@/app/api/route/route";
import { modelIntelligence } from "@/lib/models/intelligence";

/**
 * Exercises the real HTTP handler (validation, mapping, orchestration) rather
 * than calling the orchestrator directly, so the request path itself is proven.
 */
async function callRoute(body: unknown) {
  const req = new NextRequest("http://localhost:3000/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await routePOST(req);
  return (await res.json()) as {
    qualifiedCount: number;
    requirementProfile: { requiredInputModalities: string[]; requiredOutputModalities: string[] };
    rejectedModels: { reason: string }[];
    options: { recommendable: { modelId: string; name: string } };
    routeSource: string;
    caiUsed: boolean;
  };
}

describe("/api/route enforces modality through the real handler", () => {
  it("rejects models that cannot accept image input for a vision task", async () => {
    await modelIntelligence.ensureSeeded();
    const d = await callRoute({
      prompt: "Describe what is happening in this image.",
      attachments: [{
        id: "i", name: "a.png", mimeType: "image/png", size: 100, type: "image",
      }],
    });

    expect(d.requirementProfile.requiredInputModalities).toContain("IMAGE");
    expect(d.requirementProfile.requiredOutputModalities).toEqual(["TEXT"]);

    // Rejections now name the specific capability a model lacks rather than
    // a modality string: eligibility is LIST A ⊆ LIST B, so "missing Image
    // Captioning & Description" is the precise reason, and more useful than
    // "cannot accept image input".
    expect(d.rejectedModels.length).toBeGreaterThan(0);
    for (const r of d.rejectedModels) {
      expect(r.reason.toLowerCase()).toContain("missing");
    }
  }, 60_000);

  it("keeps only image-output models for an image-generation task", async () => {
    const d = await callRoute({
      prompt: "Generate a cinematic image of a cat sitting on the moon.",
      attachments: [],
    });
    expect(d.requirementProfile.requiredOutputModalities).toEqual(["IMAGE"]);

    // A model without the image-generation capability is rejected by name.
    const imageRejections = d.rejectedModels.filter((r) =>
      r.reason.toLowerCase().includes("image"));
    expect(imageRejections.length).toBeGreaterThan(0);
    expect(d.qualifiedCount).toBeGreaterThan(0);

    // And far fewer models qualify than for a text task, because producing an
    // image is a capability most of the catalog does not have.
    const text = await callRoute({ prompt: "Summarize this article.", attachments: [] });
    expect(d.qualifiedCount).toBeLessThan(text.qualifiedCount);
  }, 60_000);

  it("a vision task qualifies fewer models than a plain text task", async () => {
    const text = await callRoute({ prompt: "Summarize this article.", attachments: [] });
    const vision = await callRoute({
      prompt: "Describe what is happening in this image.",
      attachments: [{
        id: "i", name: "a.png", mimeType: "image/png", size: 100, type: "image",
      }],
    });
    expect(vision.qualifiedCount).toBeLessThan(text.qualifiedCount);
  }, 90_000);
});
