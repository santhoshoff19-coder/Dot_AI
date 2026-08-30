import { prisma } from "@/lib/db";
import { qualifyModel, type QualificationResult } from "@/lib/capability/matching";
import type {
  CapabilityProfile, ModalityKind, OutputCapability, TaskRequirementProfile,
} from "@/lib/capability/taxonomy";

export type ModelAssessmentStatus =
  | "ASSESSED" | "UNASSESSED" | "ASSESSMENT_PENDING" | "ASSESSMENT_FAILED" | "INACTIVE";

export interface IntelligentModel {
  id: string;
  openrouterModelId: string;
  name: string;
  provider: string;
  contextLength: number;
  inputPrice: number;
  outputPrice: number;
  /** False when the provider reports no usable price. */
  pricingKnown: boolean;
  latencyClass: string;
  active: boolean;
  categories: string[];
  inputModalities: ModalityKind[];
  outputModalities: ModalityKind[];
  capability: CapabilityProfile | null;
  status: ModelAssessmentStatus;
  unassessedReason: string | null;
  catalogEndpoints: string[];
  capabilityConfidence: number;
  assessmentSource: string;
}

export interface QualifiedModel extends IntelligentModel {
  capability: CapabilityProfile;
  qualification: QualificationResult;
}

/**
 * FALLBACK ONLY — not a curated shortlist.
 *
 * These entries exist so a brand-new database can route before the first
 * OpenRouter sync, and so routing survives a total catalog outage. They are
 * never consulted in preference to the real catalog: `ensureSeeded` is a no-op
 * once any OpenRouter model is present.
 */
/**
 * No seeded models.
 *
 * This list held the same three fixed mappings the registry did - "Swift",
 * "Balanced" and "Deep" bound to specific model ids - plus a hand-picked
 * image model. They were a bootstrap for a database with no catalog, but the
 * curated Model Intelligence dataset is now the source of models, costs and
 * capabilities, and it ships with the application.
 *
 * Keeping them would reintroduce exactly what this change removes: a fixed
 * set of models that routing can fall back to, under names that are not the
 * models' own.
 */
const SEED: {
  openrouterModelId: string; name: string; provider: string;
  contextLength: number; inputPrice: number; outputPrice: number;
  latencyClass: string; inputs: ModalityKind[]; outputs: ModalityKind[];
  capability: CapabilityProfile;
}[] = [];


function safeList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseOutputs(raw: string): OutputCapability[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OutputCapability[]) : ["TEXT"];
  } catch {
    return ["TEXT"];
  }
}

export class ModelIntelligenceRepository {
  /**
   * Idempotent. Seeds the fallback entries only when the catalog is empty, so
   * the real OpenRouter catalog is always the source of truth.
   */
  async ensureSeeded(): Promise<number> {
    const synced = await prisma.model.count({ where: { source: "OPENROUTER" } });
    if (synced > 0) return 0;

    let created = 0;
    for (const s of SEED) {
      const existing = await prisma.model.findUnique({
        where: { openrouterModelId: s.openrouterModelId },
      });
      if (existing) continue;

      const row = await prisma.model.create({
        data: {
          openrouterModelId: s.openrouterModelId,
          name: s.name, provider: s.provider,
          contextLength: s.contextLength,
          inputPrice: s.inputPrice, outputPrice: s.outputPrice,
          latencyClass: s.latencyClass,
          source: "SEED", active: true,
        },
      });

      await prisma.modelModality.createMany({
        data: [
          ...s.inputs.map((m) => ({ modelId: row.id, direction: "INPUT", modality: m })),
          ...s.outputs.map((m) => ({ modelId: row.id, direction: "OUTPUT", modality: m })),
        ],
      });

      await prisma.modelCategoryLink.createMany({
        data: (s.outputs.includes("IMAGE") ? ["IMAGE"] : ["TEXT"])
          .map((category) => ({ modelId: row.id, category })),
      });

      await prisma.modelCapability.create({
        data: {
          modelId: row.id,
          ...s.capability,
          outputCapabilities: JSON.stringify(s.capability.outputCapabilities),
          status: "ASSESSED",
          assessmentSource: "MANUAL",
          capabilityConfidence: 0.8,
        },
      });
      created++;
    }
    return created;
  }

  async all(includeInactive = false): Promise<IntelligentModel[]> {
    const rows = await prisma.model.findMany({
      where: includeInactive ? {} : { active: true },
      include: { capability: true, modalities: true, categories: true },
      orderBy: { inputPrice: "asc" },
    });

    return rows.map((r) => ({
      id: r.id,
      openrouterModelId: r.openrouterModelId,
      name: r.name,
      provider: r.provider,
      contextLength: r.contextLength,
      inputPrice: r.inputPrice,
      outputPrice: r.outputPrice,
      pricingKnown: r.inputPrice >= 0 && r.outputPrice >= 0,
      latencyClass: r.latencyClass,
      active: r.active,
      categories: r.categories.map((c) => c.category),
      inputModalities: r.modalities.filter((m) => m.direction === "INPUT")
        .map((m) => m.modality as ModalityKind),
      outputModalities: r.modalities.filter((m) => m.direction === "OUTPUT")
        .map((m) => m.modality as ModalityKind),
      capability: r.capability
        ? {
            effort: r.capability.effort as CapabilityProfile["effort"],
            reasoning: r.capability.reasoning as CapabilityProfile["reasoning"],
            contextHandling: r.capability.contextHandling as CapabilityProfile["contextHandling"],
            instructionComplexity:
              r.capability.instructionComplexity as CapabilityProfile["instructionComplexity"],
            reliability: r.capability.reliability as CapabilityProfile["reliability"],
            toolCapability: r.capability.toolCapability as CapabilityProfile["toolCapability"],
            outputCapabilities: parseOutputs(r.capability.outputCapabilities),
          }
        : null,
      status: (r.capability?.status ?? "ASSESSMENT_PENDING") as ModelAssessmentStatus,
      unassessedReason: r.capability?.unassessedReason ?? null,
      catalogEndpoints: safeList(r.catalogEndpoints),
      capabilityConfidence: r.capability?.capabilityConfidence ?? 0,
      assessmentSource: r.capability?.assessmentSource ?? "INITIAL",
    }));
  }

  /**
   * Applies the capability filter. Unassessed models are excluded from
   * automatic recommendation: dotAI does not guess what it has not measured.
   */
  async qualified(requirements: TaskRequirementProfile): Promise<{
    qualified: QualifiedModel[];
    rejected: { model: IntelligentModel; reason: string }[];
  }> {
    const models = await this.all();
    const qualified: QualifiedModel[] = [];
    const rejected: { model: IntelligentModel; reason: string }[] = [];

    for (const m of models) {
      // Meta-routers select a model themselves. dotAI is the routing layer, so
      // delegating to another router would hide the very decision we exist to
      // make - and its capabilities cannot be characterised.
      if (/^openrouter\/auto/.test(m.openrouterModelId)) {
        rejected.push({ model: m, reason: "Meta-router, not a concrete model." });
        continue;
      }
      if (!m.capability || m.status !== "ASSESSED") {
        rejected.push({ model: m, reason: "Capability profile has not been assessed." });
        continue;
      }
      const result = qualifyModel(m.capability, requirements, m.inputModalities);
      if (result.qualified) {
        qualified.push({ ...m, capability: m.capability, qualification: result });
      } else {
        rejected.push({ model: m, reason: result.reason });
      }
    }
    return { qualified, rejected };
  }

  async byOpenRouterId(id: string): Promise<IntelligentModel | null> {
    const all = await this.all(true);
    return all.find((m) => m.openrouterModelId === id) ?? null;
  }
}

export const modelIntelligence = new ModelIntelligenceRepository();
