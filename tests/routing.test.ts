import { describe, expect, it } from "vitest";
import { routeRequest } from "@/lib/routing/orchestrator";
import type { AttachmentRef, StreamEvent } from "@/types";

const img: AttachmentRef = {
  id: "i", name: "line.png", mimeType: "image/png", size: 10, type: "image",
  previewUrl: null, storageRef: null, extractedText: null,
};
const doc: AttachmentRef = {
  id: "d", name: "spec.txt", mimeType: "text/plain", size: 10, type: "document",
  previewUrl: null, storageRef: null, extractedText: "spec sheet contents",
};

async function route(prompt: string, attachments: AttachmentRef[] = [], settings = {}) {
  const events: StreamEvent[] = [];
  const result = await routeRequest({ prompt, attachments, settings }, (e) => events.push(e));
  return { result, events, labels: events.filter((e) => e.type === "status").map((e) => e.label) };
}

describe("routing — CAI is skipped when the task is obvious", () => {
  it("skips CAI for simple summarisation", async () => {
    const { result, labels } = await route("Summarize this 500-word article.");
    expect(result.routeSource).toBe("DIRECT");
    expect(result.caiUsed).toBe(false);
    expect(result.caiSkippedReason).toContain("CAI skipped");
    expect(labels.join(" ")).toContain("Direct routing");
  });

  it("skips CAI for translation", async () => {
    const { result } = await route("Translate this paragraph to French.");
    expect(result.routeSource).toBe("DIRECT");
    expect(result.caiUsed).toBe(false);
    expect(result.taskType).toBe("translation");
  });

  it("costs nothing to route an obvious task", async () => {
    const { result } = await route("Summarize this article.");
    expect(result.routingCostUsd).toBe(0);
  });
});

describe("routing — CAI is used when the task is ambiguous", () => {
  it("uses CAI for an ambiguous complex task", async () => {
    const { result, labels } = await route(
      "Analyze this acquisition proposal, compare financial assumptions and recommend whether we should proceed.");
    expect(result.routeSource).toBe("CAI");
    expect(result.caiUsed).toBe(true);
    expect(labels.join(" ")).toContain("CAI analysing requirements");
  });

  it("uses CAI for an ambiguous multimodal request", async () => {
    const { result } = await route(
      "Look at this manufacturing image and the spec sheet and explain what caused the defect.",
      [img, doc]);
    expect(result.caiUsed).toBe(true);
    expect(result.modalities).toContain("image");
  });

  it("uses CAI when Fast Router confidence is low", async () => {
    const { result } = await route(
      "Think through the second-order effects and tell me where the strategy might break down given everything discussed.");
    expect(result.fastRouter.confidence).toBeLessThan(0.88);
    expect(result.caiUsed).toBe(true);
  });
});

describe("routing — high-risk policy route", () => {
  it("routes an obvious financial action without CAI", async () => {
    const { result, labels } = await route("Approve this $50,000 payment.");
    expect(result.routeSource).toBe("HIGH_RISK_POLICY");
    expect(result.caiUsed).toBe(false);
    expect(labels.join(" ")).toContain("High-risk policy route");
  });

  it("forces deep verification and high effort", async () => {
    const { result } = await route("Approve this $50,000 payment.");
    expect(result.verificationDepth).toBe("deep");
    expect(result.recommendedEffort).toBe("high");
  });

  it("does not let a cheap cost preference weaken the route", async () => {
    const { result } = await route("Approve this $50,000 payment.", [], {
      costPreference: "LOWEST",
    });
    expect(result.verificationDepth).toBe("deep");
    expect(result.options.recommendable.expectedSuccess).toBeGreaterThan(0.8);
  });
});

describe("routing — model options", () => {
  it("always returns three options for the UI", async () => {
    const { result } = await route("Summarize this article.");
    expect(result.options.recommendable).toBeTruthy();
    expect(result.options.best).toBeTruthy();
    expect(result.options.alternative).toBeTruthy();
  });

  it("no longer pins a model from settings", async () => {
    // `modelPreference` used to force every request onto one model id. That
    // defeats capability matching: the pinned model may not be able to do
    // what the query needs, and the user has no way to know. Settings now
    // express a cost preference, which shapes the choice without making it.
    const { result } = await route("Summarize this article.", [], {
      costPreference: "LOWEST",
    });
    expect(result.rationale).not.toContain("Manual selection");
  });

  it("emits the progress sequence the UI renders", async () => {
    const { labels } = await route("Summarize this article.");
    expect(labels[0]).toContain("Understanding request");
    expect(labels.join(" ")).toContain("Task recognised");
    expect(labels.join(" ")).toContain("Model options ready");
  });

  it("works with no API key (mock mode)", async () => {
    const { result } = await route("Summarize this article.");
    expect(result.recommendedModel).toBeTruthy();
    expect(result.options.all.length).toBeGreaterThan(0);
  });
});
