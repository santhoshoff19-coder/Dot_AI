import { describe, expect, it } from "vitest";
import { PrivacyFirewallError, runControlPlane } from "@/lib/controlplane";
import { extractDocument } from "@/lib/documents/extract";
import { extractDocx } from "@/lib/documents/extract";
import { isValidDocx } from "@/lib/documents/generate";
import { makeDocx, makePdf } from "./fixtures/make";
import type { AttachmentRef, StreamEvent } from "@/types";
import { promises as fs } from "fs";
import path from "path";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const actor = { role: "support_agent", permissions: [] };

/** Resolves a served file URL back to its location on disk. */
function diskPathFor(url: string): string {
  const name = decodeURIComponent(url.split("/").pop() ?? "");
  return path.join(process.cwd(), "public", "uploads", name);
}

async function docAttachment(
  buffer: Buffer, name: string, mimeType: string,
): Promise<AttachmentRef> {
  const content = await extractDocument(buffer, name, mimeType);
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    name, mimeType, size: buffer.length, type: "document",
    previewUrl: null, storageRef: null,
    extractedText: content.extractedText,
    extractionStatus: content.extractionStatus,
    extractionDetail: content.detail,
    pageCount: content.pageCount,
  };
}

function imageAttachment(): AttachmentRef {
  return {
    id: "img-1", name: "receipt.png", mimeType: "image/png", size: 2048,
    type: "image", previewUrl: null, storageRef: null, extractedText: null,
  };
}

async function run(prompt: string, attachments: AttachmentRef[] = [], over = {}) {
  const events: StreamEvent[] = [];
  const out = await runControlPlane({
    requestId: `mm-${Math.random().toString(36).slice(2)}`,
    prompt, attachments, history: [], settings: {},
    destinationExternal: false, actor, ...over,
  } as Parameters<typeof runControlPlane>[0], (e) => events.push(e));
  return { ...out, events };
}

describe("MATRIX: text input", () => {
  it("TEXT → TEXT", async () => {
    const r = await run("Explain quantum computing simply.");
    expect(r.controlEvent.decision.decision).not.toBe("BLOCK");
    expect(r.answer.length).toBeGreaterThan(0);
    expect(r.document).toBeUndefined();
  }, 120_000);

  it("TEXT → IMAGE", async () => {
    const r = await run("Generate a cinematic image of an orange cat on the Moon.");
    expect(r.image).toBeTruthy();
    expect(r.image!.url.startsWith("data:image/")).toBe(true);
  }, 120_000);

  it("TEXT → DOCUMENT produces a valid, readable DOCX", async () => {
    const r = await run("Create a DOCX report about AI safety practices.");
    expect(r.document).toBeTruthy();
    expect(r.document!.fileName.endsWith(".docx")).toBe(true);

    const buffer = await fs.readFile(diskPathFor(r.document!.url));
    expect(isValidDocx(buffer)).toBe(true);

    // The artefact must contain the governed answer, not a placeholder.
    const back = await extractDocx(buffer, "out.docx", buffer.length);
    expect(back.extractionStatus).toBe("EXTRACTED");
    expect(back.wordCount).toBeGreaterThan(3);
  }, 120_000);
});

describe("MATRIX: image input", () => {
  it("IMAGE → TEXT selects a vision-capable route", async () => {
    const r = await run("What objects are visible in this image?", [imageAttachment()]);
    expect(r.controlEvent.decision.decision).not.toBe("BLOCK");
    const profile = r.controlEvent.requirementProfile;
    expect(profile?.requiredInputModalities).toContain("IMAGE");
    expect(profile?.requiredOutputModalities).toEqual(["TEXT"]);
  }, 120_000);

  it("IMAGE → DOCUMENT renders a DOCX from what the model reported", async () => {
    const r = await run(
      "Create a DOCX expense report from this receipt.", [imageAttachment()]);
    expect(r.document).toBeTruthy();
    const buffer = await fs.readFile(diskPathFor(r.document!.url));
    expect(isValidDocx(buffer)).toBe(true);
  }, 120_000);
});

describe("MATRIX: document input", () => {
  it("DOCUMENT (PDF) → TEXT reaches the model with extracted text", async () => {
    const pdf = makePdf([
      "Quarterly Financial Report",
      "Revenue grew 12 percent to 4.2 million dollars.",
    ]);
    const att = await docAttachment(pdf, "report.pdf", "application/pdf");
    expect(att.extractedText).toContain("Revenue grew 12 percent");

    const r = await run("Summarize this document.", [att]);
    expect(r.controlEvent.decision.decision).not.toBe("BLOCK");
    expect(r.answer.length).toBeGreaterThan(0);
  }, 120_000);

  it("DOCUMENT (DOCX) → TEXT", async () => {
    const docx = await makeDocx("Executive Summary", [
      "The business grew steadily across all regions.",
    ]);
    const att = await docAttachment(docx, "summary.docx", DOCX_MIME);
    expect(att.extractedText).toContain("grew steadily");

    const r = await run("Summarize this document.", [att]);
    expect(r.answer.length).toBeGreaterThan(0);
  }, 120_000);

  it("DOCUMENT → DOCUMENT", async () => {
    const pdf = makePdf(["Annual results", "Profit rose sharply this year."]);
    const att = await docAttachment(pdf, "annual.pdf", "application/pdf");
    const r = await run("Create an executive summary as a DOCX.", [att]);

    expect(r.document).toBeTruthy();
    const buffer = await fs.readFile(diskPathFor(r.document!.url));
    expect(isValidDocx(buffer)).toBe(true);
  }, 120_000);

  it("DOCUMENT → IMAGE", async () => {
    const pdf = makePdf(["Quarterly report", "Sales up across every region."]);
    const att = await docAttachment(pdf, "q.pdf", "application/pdf");
    const r = await run("Create an infographic summarizing this report.", [att]);

    // The curated taxonomy defines no Document → Image sub-task, so CAI
    // classifies this within the pairs the dataset actually offers rather
    // than inventing one. What must hold is that the request is handled
    // honestly - answered as text - not that an image appears from a
    // combination the dataset does not support.
    expect(r.controlEvent.requirementProfile?.requiredOutputModalities).toEqual(["TEXT"]);
    expect(r.answer.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("failure paths are explicit, never silent", () => {
  it("refuses to answer about a document it could not read", async () => {
    const junk = Buffer.from("not a real pdf");
    const att = await docAttachment(junk, "broken.pdf", "application/pdf");
    expect(att.extractionStatus).toBe("EXTRACTION_FAILED");

    await expect(run("Summarize this document.", [att])).rejects.toThrow();
  }, 120_000);

  it("refuses a scanned PDF rather than pretending it was read", async () => {
    const blank = makePdf([]);
    const att = await docAttachment(blank, "scan.pdf", "application/pdf");
    expect(att.extractionStatus).toBe("DOCUMENT_TEXT_UNAVAILABLE");
    await expect(run("Summarize this.", [att])).rejects.toThrow();
  }, 120_000);

  it("does not create a document when the content is blocked", async () => {
    // The privacy firewall stops this before generation, so no document is
    // rendered because nothing was ever generated. Either outcome satisfies
    // the guarantee: a blocked request must not leave a file behind.
    let document: unknown;
    let stopped = false;
    try {
      const r = await run(
        "Create a DOCX containing customer account number 4488-1234-5678-9010 for an external recipient.",
        [], { destinationExternal: true });
      document = r.document;
      stopped = r.controlEvent.decision.decision === "BLOCK";
    } catch (err) {
      if (!(err instanceof PrivacyFirewallError)) throw err;
      stopped = true;
    }

    expect(stopped).toBe(true);
    expect(document).toBeUndefined();
  }, 120_000);
});
