import { prisma } from "@/lib/db";
import { embeddingService } from "@/lib/policy/embeddings";
import { vectorStore } from "@/lib/policy/vector-store";
import {
  POLICY_CATEGORIES, type Jurisdiction, type PolicyCategory,
} from "@/lib/policy/taxonomy";

export interface IngestSection {
  section: string;
  text: string;
  category: PolicyCategory;
}

export interface IngestInput {
  name: string;
  jurisdiction: Jurisdiction;
  regulation: string;
  version: string;
  sections: IngestSection[];
  source?: string;
  sourceUrl?: string;
  isDemo?: boolean;
  effectiveDate?: Date;
}

export interface IngestResult {
  documentId: string;
  chunks: number;
  embeddingModel: string;
  retrievalMode: string;
  costUsd: number;
}

/** Sentences repeated into the next chunk, so a rule split across a boundary
 *  is still retrievable from either side. */
export const CHUNK_OVERLAP_SENTENCES = Number(process.env.CHUNK_OVERLAP ?? 1);

/**
 * Splits a long section so a retrieved chunk is quotable, not a whole page.
 *
 * Chunks overlap by a sentence: a requirement whose condition and consequence
 * straddle a boundary would otherwise be retrievable only in half.
 */
export function chunkText(text: string, maxChars = 700): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  const sentences = clean.split(/(?<=[.;])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  for (const s of sentences) {
    const candidate = [...current, s].join(" ");
    if (candidate.length > maxChars && current.length) {
      chunks.push(current.join(" ").trim());
      // Carry the tail forward as context for the next chunk.
      current = current.slice(-CHUNK_OVERLAP_SENTENCES).concat(s);
    } else {
      current.push(s);
    }
  }
  if (current.length) chunks.push(current.join(" ").trim());
  return chunks;
}

/**
 * Recognises a heading line.
 *
 * Real policy and contract documents rarely use markdown. They number their
 * clauses — "1. DATA OWNERSHIP", "4.2 Deletion", "ARTICLE III" — and an
 * earlier parser recognised only markdown hashes and the literal words
 * Article/Section/Clause. Everything else collapsed into a single "Preamble"
 * chunk covering the whole file, so retrieval could only ever return that
 * preamble and no clause-level evidence existed to ground anything against.
 */
export function detectHeading(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line || line.length > 120) return null;

  // Markdown: # Heading
  const md = /^#{1,6}\s+(.+)$/.exec(line);
  if (md) return md[1].trim();

  // Explicitly labelled: Article 4, Section 2.1, Clause 6, Annex D, Schedule 2
  const labelled =
    /^(?:article|section|clause|annex|appendix|schedule|part)\s+([\w.]+)\s*[-–—:.]?\s*(.*)$/i
      .exec(line);
  if (labelled) {
    return (labelled[2] ? `${labelled[1]} ${labelled[2]}` : labelled[1]).trim();
  }

  // Numbered clause: "1. DATA OWNERSHIP", "4.2 Deletion and return"
  const numbered = /^(\d+(?:\.\d+)*)\s*[.)]?\s+(.{2,100})$/.exec(line);
  if (numbered) {
    const title = numbered[2].trim();
    // A numbered heading is a title, not a sentence. Prose that happens to
    // start with a number must not split the document.
    const looksLikeTitle =
      !/[.;]$/.test(title) &&
      title.split(/\s+/).length <= 12 &&
      (title === title.toUpperCase() || /^[A-Z]/.test(title));
    if (looksLikeTitle) return `${numbered[1]} ${title}`;
  }

  // ALL-CAPS heading on its own line: "DATA OWNERSHIP AND USE"
  if (
    /^[A-Z][A-Z0-9 ,&/()'-]{3,79}$/.test(line) &&
    line.split(/\s+/).length <= 10 &&
    !/[.;:]$/.test(line)
  ) {
    return line;
  }

  return null;
}

/** Extracts sections from plain text or markdown headings. */
export function parseSections(raw: string): { section: string; text: string }[] {
  const lines = raw.split(/\r?\n/);
  const out: { section: string; text: string }[] = [];
  let section = "Preamble";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").trim();
    if (text) out.push({ section, text });
    buffer = [];
  };

  for (const line of lines) {
    const heading = detectHeading(line);
    if (heading) {
      flush();
      section = heading.slice(0, 120);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

export class PolicyIngestionService {
  /**
   * Ingests one policy document: chunk, embed, store.
   *
   * Re-ingesting the same regulation at a new version creates a new document
   * and marks the old one SUPERSEDED rather than overwriting it, so decisions
   * made under the old text stay explainable.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const existing = await prisma.policyDocument.findFirst({
      where: {
        regulation: input.regulation,
        jurisdiction: input.jurisdiction,
        version: input.version,
      },
    });
    if (existing) {
      const chunks = await prisma.policyChunk.count({ where: { documentId: existing.id } });
      return {
        documentId: existing.id, chunks,
        embeddingModel: "unchanged", retrievalMode: "unchanged", costUsd: 0,
      };
    }

    // Any earlier version of the same regulation is superseded, never deleted.
    await prisma.policyDocument.updateMany({
      where: {
        regulation: input.regulation,
        jurisdiction: input.jurisdiction,
        status: "ACTIVE",
      },
      data: { status: "SUPERSEDED" },
    });

    const doc = await prisma.policyDocument.create({
      data: {
        name: input.name,
        jurisdiction: input.jurisdiction,
        regulation: input.regulation,
        version: input.version,
        source: input.source ?? "DEMO",
        sourceUrl: input.sourceUrl ?? null,
        isDemo: input.isDemo ?? true,
        effectiveDate: input.effectiveDate ?? new Date(),
        status: "ACTIVE",
      },
    });

    const pending: { section: string; text: string; category: PolicyCategory }[] = [];
    for (const s of input.sections) {
      const category = POLICY_CATEGORIES.includes(s.category) ? s.category : "OTHER";
      for (const piece of chunkText(s.text)) {
        pending.push({ section: s.section, text: piece, category });
      }
    }

    const embedded = await embeddingService.embed(pending.map((p) => p.text));

    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      await prisma.policyChunk.create({
        data: {
          documentId: doc.id,
          section: p.section,
          text: p.text,
          jurisdiction: input.jurisdiction,
          regulation: input.regulation,
          version: input.version,
          category: p.category,
          embedding: JSON.stringify(embedded.vectors[i] ?? []),
          embeddingModel: embedded.model,
        },
      });
    }

    return {
      documentId: doc.id,
      chunks: pending.length,
      embeddingModel: embedded.model,
      retrievalMode: embedded.mode,
      costUsd: embedded.costUsd,
    };
  }

  /** Ingests a raw text or markdown file. */
  async ingestRaw(
    raw: string,
    meta: Omit<IngestInput, "sections"> & { defaultCategory?: PolicyCategory },
  ): Promise<IngestResult> {
    const sections = parseSections(raw).map((s) => ({
      ...s,
      category: inferCategory(s.section + " " + s.text, meta.defaultCategory),
    }));
    return this.ingest({ ...meta, sections });
  }

  /**
   * Hard-deletes a policy document and everything indexed from it.
   *
   * The PolicyChunk cascade removes the chunks, and embeddings live in the
   * chunk row rather than a separate store, so they go with them. The result
   * is verified rather than assumed: a delete that silently left retrievable
   * chunks behind would keep influencing decisions after the policy was gone.
   *
   * Past decisions are unaffected - PolicyDecisionRecord stores a JSON
   * snapshot of the evidence, not a foreign key, so audit history survives.
   */
  async deleteDocument(id: string): Promise<{
    deleted: boolean;
    documentName: string;
    chunksRemoved: number;
    orphanedChunks: number;
  }> {
    const doc = await prisma.policyDocument.findUnique({
      where: { id },
      include: { _count: { select: { chunks: true } } },
    });
    if (!doc) {
      return { deleted: false, documentName: "", chunksRemoved: 0, orphanedChunks: 0 };
    }

    const before = doc._count.chunks;
    await prisma.policyDocument.delete({ where: { id } });

    // Verify the cascade actually ran; never report success on assumption.
    const orphaned = await prisma.policyChunk.count({ where: { documentId: id } });
    if (orphaned > 0) {
      // Belt and braces: remove anything the cascade missed so no orphaned
      // vector remains retrievable.
      await prisma.policyChunk.deleteMany({ where: { documentId: id } });
    }
    const stillOrphaned = await prisma.policyChunk.count({ where: { documentId: id } });

    return {
      deleted: true,
      documentName: doc.name,
      chunksRemoved: before,
      orphanedChunks: stillOrphaned,
    };
  }

  /** One document with its indexed sections, for the View panel. */
  async getDocument(id: string) {
    return prisma.policyDocument.findUnique({
      where: { id },
      include: {
        chunks: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true, section: true, text: true, category: true,
            embeddingModel: true,
          },
        },
      },
    });
  }

  async listDocuments() {
    return prisma.policyDocument.findMany({
      orderBy: [{ jurisdiction: "asc" }, { regulation: "asc" }],
      include: { _count: { select: { chunks: true } } },
    });
  }

  /**
   * Seeds the demo packs on a fresh database.
   *
   * Idempotent, and it only ever runs once: a marker is written on first
   * seed, so deleting the demo packs is permanent. Counting documents alone
   * was not enough - a user who deleted every pack got them back on their
   * next request, which made deletion look broken.
   */
  async ensureSeeded(): Promise<number> {
    if (await this.hasSeeded()) return 0;

    const existing = await prisma.policyDocument.count();
    if (existing > 0) {
      // Documents predate the marker. Record that seeding is done so the
      // packs are not injected alongside content the user already has.
      await this.markSeeded();
      return 0;
    }

    let created = 0;
    for (const pack of DEMO_POLICY_PACKS) {
      await this.ingest(pack);
      created++;
    }
    await this.markSeeded();
    return created;
  }

  /**
   * The marker lives on disk beside the database rather than in a table, so
   * no migration is required for it.
   */
  private markerPath(): string {
    return `${process.cwd()}/.policy-seeded`;
  }

  private async hasSeeded(): Promise<boolean> {
    try {
      const { promises: fs } = await import("fs");
      await fs.access(this.markerPath());
      return true;
    } catch {
      return false;
    }
  }

  private async markSeeded(): Promise<void> {
    try {
      const { promises: fs } = await import("fs");
      await fs.writeFile(this.markerPath(), new Date().toISOString(), "utf8");
    } catch (err) {
      // Failing to write the marker only means the packs may be re-seeded on
      // an empty database. It must not fail the request.
      console.error("[policy] could not record demo seeding", err);
    }
  }

  /**
   * Restores the demo packs after they have been deleted. Explicit, because
   * seeding is otherwise a one-time event.
   */
  async reseedDemoPacks(): Promise<number> {
    let created = 0;
    for (const pack of DEMO_POLICY_PACKS) {
      const exists = await prisma.policyDocument.findFirst({
        where: {
          regulation: pack.regulation,
          jurisdiction: pack.jurisdiction,
          version: pack.version,
        },
      });
      if (exists) continue;
      await this.ingest(pack);
      created++;
    }
    await this.markSeeded();
    return created;
  }
}

function inferCategory(text: string, fallback?: PolicyCategory): PolicyCategory {
  const t = text.toLowerCase();
  if (/transfer|third countr|outside|external recipient|cross-border/.test(t)) return "DATA_TRANSFER";
  if (/health|medical|biometric|racial|religio|special categor/.test(t)) return "SENSITIVE_DATA";
  if (/consent/.test(t)) return "CONSENT";
  if (/retention|erasure|delete|storage limit/.test(t)) return "RETENTION";
  if (/encrypt|breach|access control|authoris|authoriz/.test(t)) return "SECURITY";
  if (/automated|profiling|solely automated/.test(t)) return "AUTOMATED_DECISION";
  if (/personal data|data subject|identifier/.test(t)) return "PERSONAL_DATA";
  if (/safety|harm/.test(t)) return "SAFETY";
  return fallback ?? "OTHER";
}

/**
 * DEMONSTRATION POLICY PACKS — NOT LEGAL TEXT.
 *
 * These are short, plain-English summaries written for this prototype so the
 * retrieval and decision path can be exercised. They are deliberately marked
 * isDemo and must not be read as the actual wording of any regulation, nor as
 * a statement that any system is compliant with it.
 */
export const DEMO_POLICY_PACKS: IngestInput[] = [
  {
    name: "EU personal data handling (DEMO summary, not legal text)",
    jurisdiction: "EU",
    regulation: "GDPR",
    version: "demo-1.0",
    source: "DEMO",
    isDemo: true,
    sections: [
      {
        section: "Special categories of personal data",
        category: "SENSITIVE_DATA",
        text: "Health and medical information about an identified person is treated as a special category of personal data. Handling it requires an explicit lawful basis, and it must not be disclosed casually in the course of ordinary support work.",
      },
      {
        section: "Transfers to external recipients",
        category: "DATA_TRANSFER",
        text: "Personal data must not be sent to a recipient outside the organisation unless a documented transfer mechanism and lawful basis exist for that recipient. An unverified external email address is not an approved transfer channel.",
      },
      {
        section: "Data minimisation",
        category: "PERSONAL_DATA",
        text: "Only the personal data necessary for the stated purpose may be disclosed. Account identifiers should be masked where the purpose can be achieved without them.",
      },
      {
        section: "Automated decision-making",
        category: "AUTOMATED_DECISION",
        text: "A decision producing legal or similarly significant effects should not rest solely on automated processing without human involvement.",
      },
    ],
  },
  {
    name: "India personal data handling (DEMO summary, not legal text)",
    jurisdiction: "IN",
    regulation: "DPDP",
    version: "demo-1.0",
    source: "DEMO",
    isDemo: true,
    sections: [
      {
        section: "Purpose limitation and notice",
        category: "PERSONAL_DATA",
        text: "Personal data may be processed for the purpose for which it was provided, with notice to the person concerned. Disclosure beyond that purpose requires a fresh basis.",
      },
      {
        section: "Disclosure to third parties",
        category: "DATA_TRANSFER",
        text: "Sharing personal data with a third party requires the person's consent or another permitted ground. Support staff should route such requests to an approved channel rather than sending data directly.",
      },
      {
        section: "Security safeguards",
        category: "SECURITY",
        text: "Reasonable security safeguards must protect personal data against unauthorised access and disclosure.",
      },
    ],
  },
  {
    name: "Internal AI safety and disclosure standard (DEMO)",
    jurisdiction: "GLOBAL",
    regulation: "INTERNAL",
    version: "demo-1.0",
    source: "DEMO",
    isDemo: true,
    sections: [
      {
        section: "Unverified statements to customers",
        category: "AUTOMATED_DECISION",
        text: "An assistant must not present an unverified factual claim to a customer as settled fact. Where a claim cannot be grounded in a source of record, it must be marked as unverified or withheld.",
      },
      {
        section: "Internal identifiers",
        category: "ACCESS_CONTROL",
        text: "Internal account numbers and system identifiers are for internal use. They may be shown to authorised staff inside internal tools and must not be included in outbound customer communications.",
      },
      {
        section: "Escalation of consequential actions",
        category: "SAFETY",
        text: "Any action that moves money, changes entitlements or discloses customer records requires human approval before execution.",
      },
    ],
  },
];

export const policyIngestion = new PolicyIngestionService();
