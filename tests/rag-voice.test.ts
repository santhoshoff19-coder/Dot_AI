import { describe, expect, it } from "vitest";
import { retrievalDecision, type RagMode } from "@/lib/rag/decision";
import { getProfile } from "@/lib/governance/profiles";
import { PrivacyFirewallError, runControlPlane } from "@/lib/controlplane";
import {
  ALLOWED_AUDIO_MIME, MAX_AUDIO_BYTES, TRANSCRIPTION_MODEL, audioFormatFor,
} from "@/lib/voice/config";
import { POST as transcribePOST } from "@/app/api/transcribe/route";
import { NextRequest } from "next/server";

const decide = (prompt: string, ragMode: RagMode = "AUTO", over = {}) =>
  retrievalDecision.decide({ prompt, ragMode, ...over });

describe("3-5. AUTO decides retrieval from the request", () => {
  it("skips retrieval for a general knowledge question", () => {
    const d = decide("Explain recursion simply.");
    expect(d.shouldRetrieve).toBe(false);
    expect(d.retrievalType).toBe("NONE");
  });

  it("skips retrieval for creative writing", () => {
    expect(decide("Write a poem about the sea.").shouldRetrieve).toBe(false);
  });

  it("skips retrieval for a greeting", () => {
    expect(decide("hello there").shouldRetrieve).toBe(false);
  });

  it("retrieves for a company-knowledge question", () => {
    const d = decide("What is our refund policy?");
    expect(d.shouldRetrieve).toBe(true);
    expect(["POLICY", "BOTH"]).toContain(d.retrievalType);
  });

  it("retrieves when a document is attached", () => {
    const d = decide("Summarize this.", "AUTO", { hasAttachments: true });
    expect(d.shouldRetrieve).toBe(true);
    expect(d.preGeneration).toBe(true);
  });

  it("retrieves policy for a permission question", () => {
    const d = decide("Am I allowed to send this to an external partner?");
    expect(d.retrievalType === "POLICY" || d.retrievalType === "BOTH").toBe(true);
  });

  it("retrieves both when company knowledge meets a governed action", () => {
    const d = decide("What is our Q3 revenue and can I share it externally?");
    expect(d.retrievalType).toBe("BOTH");
  });

  it("retrieves when a risk category was already detected", () => {
    const d = decide("Say hello", "AUTO", { riskCategories: ["PRIVACY"] });
    expect(d.shouldRetrieve).toBe(true);
  });
});

describe("6-8. manual modes override the decision", () => {
  it("ON forces retrieval on a request that would skip it", () => {
    const d = decide("Explain recursion simply.", "ON");
    expect(d.shouldRetrieve).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.reason).toContain("forced on");
  });

  it("OFF suppresses retrieval on a request that would use it", () => {
    const d = decide("What is our refund policy?", "OFF");
    expect(d.shouldRetrieve).toBe(false);
    expect(d.bypassed).toBe(true);
  });

  it("labels the state for the UI", () => {
    expect(retrievalDecision.label(decide("hi"))).toBe("NOT USED");
    expect(retrievalDecision.label(decide("hi", "OFF"))).toBe("OFF");
    expect(retrievalDecision.label(decide("hi", "ON"))).toContain("FORCED ON");
  });

  it("post-generation verification is reserved for consequential output", () => {
    const low = decide("What is our policy?", "AUTO", {
      profile: getProfile("BASELINE"),
    });
    const high = decide("What is our policy?", "AUTO", {
      profile: getProfile("BASELINE"), riskLevel: "critical",
    });
    expect(high.postGeneration).toBe(true);
    expect(low.postGeneration).toBe(false);
  });

  it("never verifies after image generation", () => {
    const d = decide("generate a cat pic", "ON", { outputModality: "IMAGE" });
    expect(d.postGeneration).toBe(false);
  });
});

describe("9. disabling retrieval never disables governance", () => {
  it("still blocks a data leak with RAG OFF", async () => {
    // The privacy firewall now stops this before generation. That is earlier
    // than the post-answer block this once asserted, and strictly better: the
    // account number never reaches a provider at all. What must hold is that
    // the leak is stopped with retrieval switched off, not where.
    let decision = "";
    try {
      const r = await runControlPlane({
        requestId: `rag-off-${Date.now()}`,
        prompt: "Send John's account number 4488-1234-5678-9010 to an external email.",
        attachments: [], history: [], settings: {},
        destinationExternal: true, ragMode: "OFF",
        actor: { role: "support_agent", permissions: [] },
      } as Parameters<typeof runControlPlane>[0], () => {});
      decision = r.controlEvent.decision.decision;
      expect(r.controlEvent.rag?.triggered).toBeFalsy();
    } catch (err) {
      if (!(err instanceof PrivacyFirewallError)) throw err;
      decision = err.firewall.decision;
    }

    expect(["BLOCK", "HOLD"]).toContain(decision);
  }, 120_000);

  it("records the retrieval mode on the control event", async () => {
    const r = await runControlPlane({
      requestId: `rag-meta-${Date.now()}`,
      // No identifiers: this test is about the retrieval metadata being
      // recorded, and a prompt the privacy firewall stops never reaches the
      // point where that metadata exists.
      prompt: "What is our policy on refund timelines?",
      attachments: [], history: [], settings: {},
      destinationExternal: false, ragMode: "AUTO",
      actor: { role: "support_agent", permissions: [] },
    } as Parameters<typeof runControlPlane>[0], () => {});

    expect(r.controlEvent.rag).toBeTruthy();
    expect(r.controlEvent.rag!.mode).toBe("AUTO");
    expect(typeof r.controlEvent.rag!.chunksRetrieved).toBe("number");
  }, 120_000);
});

describe("22-27. voice transcription", () => {
  it("uses a real transcription model, not a placeholder", () => {
    expect(TRANSCRIPTION_MODEL).toContain("whisper");
  });

  it("maps audio mime types to provider formats", () => {
    expect(audioFormatFor("audio/webm;codecs=opus")).toBe("webm");
    expect(audioFormatFor("audio/wav")).toBe("wav");
    expect(audioFormatFor("audio/mpeg")).toBe("mp3");
  });

  it("accepts the formats the recorder produces", () => {
    expect(ALLOWED_AUDIO_MIME.has("audio/webm")).toBe(true);
    expect(ALLOWED_AUDIO_MIME.has("audio/wav")).toBe(true);
    expect(ALLOWED_AUDIO_MIME.has("text/plain")).toBe(false);
  });

  it("caps upload size below the provider limit", () => {
    expect(MAX_AUDIO_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it("rejects a request with no audio", async () => {
    const res = await transcribePOST(new NextRequest("http://localhost/api/transcribe", {
      method: "POST", body: new FormData(),
    }));
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported audio type", async () => {
    const form = new FormData();
    form.set("audio", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await transcribePOST(new NextRequest("http://localhost/api/transcribe", {
      method: "POST", body: form,
    }));
    expect(res.status).toBe(415);
  });

  it("says plainly that no key is connected rather than faking a transcript", async () => {
    const form = new FormData();
    form.set("audio", new File([new Uint8Array([1, 2, 3])], "a.webm", { type: "audio/webm" }));
    const res = await transcribePOST(new NextRequest("http://localhost/api/transcribe", {
      method: "POST", body: form,
    }));
    const body = await res.json();

    // Without credentials the honest outcome is an error, never invented text.
    expect(res.status).toBe(400);
    expect(body.code).toBe("NO_CREDENTIALS");
    expect(body.text).toBeUndefined();
  });
});
