import { describe, expect, it } from "vitest";
import {
  cleanText, extractDocument, extractDocx, extractPdf, hasUsableText,
} from "@/lib/documents/extract";
import { generateDocx, isValidDocx, safeDocName, toBlocks } from "@/lib/documents/generate";
import {
  checkSupport, primaryInputModality, resolveOutputModality, CAPABILITY_MATRIX,
} from "@/lib/documents/matrix";
import { makeDocx, makePdf } from "./fixtures/make";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("PDF extraction", () => {
  it("extracts text from a real text-based PDF", async () => {
    const pdf = makePdf([
      "Quarterly Financial Report",
      "Revenue grew 12 percent to 4.2 million dollars.",
    ]);
    const r = await extractPdf(pdf, "report.pdf", pdf.length);
    expect(r.extractionStatus).toBe("EXTRACTED");
    expect(r.extractedText).toContain("Quarterly Financial Report");
    expect(r.extractedText).toContain("Revenue grew 12 percent");
    expect(r.pageCount).toBe(1);
    expect(r.wordCount).toBeGreaterThan(5);
  }, 60_000);

  it("rejects a corrupted PDF rather than returning empty text", async () => {
    const junk = Buffer.from("this is definitely not a pdf file at all");
    const r = await extractPdf(junk, "broken.pdf", junk.length);
    expect(r.extractionStatus).toBe("EXTRACTION_FAILED");
    expect(r.extractedText).toBeNull();
    expect(r.detail).toContain("not a valid PDF");
  }, 60_000);

  it("reports a text-free PDF as unavailable, not as success", async () => {
    const blank = makePdf([]);
    const r = await extractPdf(blank, "scan.pdf", blank.length);
    expect(r.extractionStatus).toBe("DOCUMENT_TEXT_UNAVAILABLE");
    expect(hasUsableText(r)).toBe(false);
    expect(r.detail).toContain("OCR");
  }, 60_000);
});

describe("DOCX extraction", () => {
  it("extracts paragraphs from a real DOCX", async () => {
    const docx = await makeDocx("Executive Summary", [
      "The business grew steadily across all regions.",
      "Margins improved in the second half.",
    ]);
    const r = await extractDocx(docx, "summary.docx", docx.length);
    expect(r.extractionStatus).toBe("EXTRACTED");
    expect(r.extractedText).toContain("Executive Summary");
    expect(r.extractedText).toContain("Margins improved");
  }, 60_000);

  it("rejects a corrupted DOCX", async () => {
    const junk = Buffer.from("not a zip archive");
    const r = await extractDocx(junk, "broken.docx", junk.length);
    expect(r.extractionStatus).toBe("EXTRACTION_FAILED");
    expect(r.extractedText).toBeNull();
  }, 60_000);

  it("reports an empty DOCX honestly", async () => {
    const docx = await makeDocx("", []);
    const r = await extractDocx(docx, "empty.docx", docx.length);
    expect(["DOCUMENT_TEXT_UNAVAILABLE", "EXTRACTED"]).toContain(r.extractionStatus);
    if (r.extractionStatus === "DOCUMENT_TEXT_UNAVAILABLE") {
      expect(r.extractedText).toBeNull();
    }
  }, 60_000);
});

describe("document router", () => {
  it("dispatches by mime type", async () => {
    const pdf = makePdf(["Hello from a PDF document."]);
    expect((await extractDocument(pdf, "a.pdf", "application/pdf")).extractionStatus)
      .toBe("EXTRACTED");

    const docx = await makeDocx("Title", ["Body text here."]);
    expect((await extractDocument(docx, "a.docx", DOCX_MIME)).extractionStatus)
      .toBe("EXTRACTED");

    const txt = Buffer.from("Plain text content for the model.");
    expect((await extractDocument(txt, "a.txt", "text/plain")).extractionStatus)
      .toBe("EXTRACTED");
  }, 60_000);

  it("flags an empty file and an unsupported format", async () => {
    expect((await extractDocument(Buffer.alloc(0), "e.txt", "text/plain")).extractionStatus)
      .toBe("EMPTY_DOCUMENT");
    expect((await extractDocument(Buffer.from("x"), "a.zip", "application/zip")).extractionStatus)
      .toBe("UNSUPPORTED_FORMAT");
  }, 60_000);

  it("normalises whitespace without destroying paragraphs", () => {
    expect(cleanText("A  line\n\n\n\nAnother   line")).toBe("A line\n\nAnother line");
  });
});

describe("DOCX generation", () => {
  it("produces a structurally valid DOCX, not renamed text", async () => {
    const d = await generateDocx({
      title: "AI Safety Report",
      content: "# Overview\nSafety matters.\n- First point\n- Second point",
    });
    expect(isValidDocx(d.buffer)).toBe(true);
    expect(d.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(d.size).toBeGreaterThan(1000);
    expect(d.fileName.endsWith(".docx")).toBe(true);
  }, 60_000);

  it("round-trips: the generated DOCX can be read back", async () => {
    const d = await generateDocx({
      title: "Quarterly Review",
      content: "Revenue increased by twelve percent this quarter.",
    });
    const back = await extractDocx(d.buffer, d.fileName, d.size);
    expect(back.extractionStatus).toBe("EXTRACTED");
    expect(back.extractedText).toContain("Revenue increased by twelve percent");
    expect(back.extractedText).toContain("Quarterly Review");
  }, 60_000);

  it("renders headings, bullets and numbered lists as blocks", () => {
    const blocks = toBlocks("# Title\n- one\n- two\n1. first\nPlain paragraph");
    expect(blocks.length).toBe(5);
  });

  it("sanitises the filename", () => {
    expect(safeDocName("../../etc/passwd report")).not.toContain("/");
    expect(safeDocName("")).toBe("dotai-document.docx");
  });

  it("labels a simulated document", async () => {
    const d = await generateDocx({
      title: "T", content: "c", simulated: true, notice: "mock mode",
    });
    expect(d.simulated).toBe(true);
  }, 60_000);
});

describe("capability matrix", () => {
  it("declares every V1 combination", () => {
    for (const input of ["TEXT", "IMAGE", "DOCUMENT"] as const) {
      for (const output of ["TEXT", "IMAGE", "DOCUMENT"] as const) {
        expect(CAPABILITY_MATRIX[input][output].supported).toBe(true);
      }
    }
  });

  it("marks image-to-image as conditional on the model", () => {
    const c = checkSupport("IMAGE", "IMAGE");
    expect(c.conditional).toBe(true);
    expect(c.cell.requiresModelInput).toContain("IMAGE");
    expect(c.cell.requiresModelOutput).toBe("IMAGE");
  });

  it("requires a text model for document output", () => {
    expect(checkSupport("DOCUMENT", "DOCUMENT").cell.requiresModelOutput).toBe("TEXT");
    expect(checkSupport("TEXT", "DOCUMENT").cell.requiresModelOutput).toBe("TEXT");
  });

  it("detects the primary input modality", () => {
    expect(primaryInputModality([])).toBe("TEXT");
    expect(primaryInputModality([{ type: "document" }])).toBe("DOCUMENT");
    expect(primaryInputModality([{ type: "document" }, { type: "image" }])).toBe("IMAGE");
  });
});

describe("output type resolution", () => {
  it("routes an explicit DOCX request to document output, not text", () => {
    for (const p of [
      "Create a DOCX report about AI safety.",
      "Write this up as a Word document.",
      "Produce a downloadable report",
    ]) {
      const r = resolveOutputModality(p);
      expect(r.output).toBe("DOCUMENT");
      expect(r.source).toBe("EXPLICIT_REQUEST");
    }
  });

  it("routes an explicit image request to image output", () => {
    expect(resolveOutputModality("Create an infographic summarising this").output).toBe("IMAGE");
    expect(resolveOutputModality("Generate an image of a cat").output).toBe("IMAGE");
  });

  it("defaults to text", () => {
    const r = resolveOutputModality("Summarize this document.");
    expect(r.output).toBe("TEXT");
    expect(r.source).toBe("INFERRED");
  });

  it("lets an explicit user selection override inference", () => {
    const r = resolveOutputModality("Generate an image of a cat", "DOCUMENT");
    expect(r.output).toBe("DOCUMENT");
    expect(r.source).toBe("USER_OVERRIDE");
  });
});
