import { prisma } from "@/lib/db";
import {
  EVIDENCE_CONFIDENCE, type CapabilityProfile, type EvidenceLevel, type Level,
  type OutputCapability, type ToolCapability,
} from "@/lib/capability/taxonomy";

export const ASSESSMENT_VERSION = "v1";

export interface AssessmentInput {
  openrouterModelId: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  description?: string | null;
}

export interface AssessmentOutcome {
  assessed: boolean;
  reason?: string;
  profile?: CapabilityProfile;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  fieldConfidence: Record<string, number>;
}

/**
 * Automatic capability assessment.
 *
 * The rule that governs this file: derive only what the evidence supports.
 * Modalities, context window and supported parameters are facts reported by
 * the provider, so fields derived from them are DIRECT_PROVIDER_DATA. Anything
 * that would require guessing — above all reasoning quality — is either left
 * conservative and marked INFERRED, or the model stays UNASSESSED.
 *
 * Explicitly NOT done here: treating price or context size as a proxy for
 * intelligence. An expensive model is not therefore a strong reasoner.
 */
export class ModelCapabilityAssessmentService {
  assess(input: AssessmentInput): AssessmentOutcome {
    const outputs = input.outputModalities.map((m) => m.toUpperCase());
    const inputs = input.inputModalities.map((m) => m.toUpperCase());
    const params = input.supportedParameters.map((p) => p.toLowerCase());

    // --- Output capability: a direct provider fact -----------------------
    const outputCapabilities = outputs
      .filter((o): o is OutputCapability =>
        ["TEXT", "IMAGE", "AUDIO", "VIDEO", "EMBEDDING", "RERANK"].includes(o))
      .filter((v, i, a) => a.indexOf(v) === i);

    if (outputCapabilities.length === 0) {
      return {
        assessed: false,
        reason: "Provider reports no recognised output modality.",
        evidenceLevel: "INFERRED",
        confidence: 0,
        fieldConfidence: {},
      };
    }

    // --- Context handling: normalised from the reported window ------------
    // The window is a fact; the banding is dotAI's normalisation of it.
    const contextHandling: Level =
      input.contextLength >= 180_000 ? "HIGH"
      : input.contextLength >= 32_000 ? "MEDIUM"
      : "LOW";

    if (input.contextLength <= 0) {
      return {
        assessed: false,
        reason: "Provider reports no context length, so context handling cannot be established.",
        evidenceLevel: "INFERRED",
        confidence: 0,
        fieldConfidence: {},
      };
    }

    // --- Tool capability: derived from supported parameters ---------------
    const hasTools = params.includes("tools") || params.includes("tool_choice");
    const hasParallelTools = params.includes("parallel_tool_calls");
    const toolCapability: ToolCapability =
      hasTools && hasParallelTools ? "ADVANCED" : hasTools ? "BASIC" : "NONE";

    // --- Reasoning: only claimed when the provider exposes reasoning ------
    // controls. Otherwise it is conservative and marked inferred.
    const exposesReasoning =
      params.includes("reasoning") || params.includes("include_reasoning") ||
      params.includes("reasoning_effort");

    const reasoning: Level = exposesReasoning ? "HIGH" : "MEDIUM";

    // --- Effort capacity: reasoning controls plus a usable window ---------
    const effort: Level =
      exposesReasoning && contextHandling !== "LOW" ? "HIGH"
      : contextHandling === "LOW" ? "LOW"
      : "MEDIUM";

    // --- Instruction complexity: structured-output support is evidence ----
    const structured =
      params.includes("response_format") || params.includes("structured_outputs");
    const instructionComplexity: Level = structured ? "HIGH" : "MEDIUM";

    // --- Reliability: NOT inferable from metadata. Start conservative and
    // let observed dotAI outcomes move it through the feedback loop.
    const reliability: Level = "MEDIUM";

    // Non-text output models are a special case: a diffusion image model has
    // no meaningful reasoning or tool profile, so those fields are pinned low
    // rather than guessed.
    const textOut = outputCapabilities.includes("TEXT");
    const profile: CapabilityProfile = textOut
      ? {
          effort, reasoning, contextHandling, instructionComplexity,
          reliability, toolCapability, outputCapabilities,
        }
      : {
          effort: "MEDIUM", reasoning: "LOW", contextHandling: "LOW",
          instructionComplexity: "MEDIUM", reliability: "MEDIUM",
          toolCapability: "NONE", outputCapabilities,
        };

    // --- Evidence level and per-field confidence --------------------------
    // Fields read straight from provider metadata are trusted more highly
    // than fields dotAI had to infer.
    const fieldConfidence: Record<string, number> = {
      outputCapabilities: EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA,
      contextHandling: EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA,
      toolCapability: hasTools
        ? EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA
        : EVIDENCE_CONFIDENCE.INFERRED,
      instructionComplexity: structured
        ? EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA
        : EVIDENCE_CONFIDENCE.INFERRED,
      reasoning: exposesReasoning
        ? EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA
        : EVIDENCE_CONFIDENCE.INFERRED,
      effort: exposesReasoning
        ? EVIDENCE_CONFIDENCE.DIRECT_PROVIDER_DATA
        : EVIDENCE_CONFIDENCE.INFERRED,
      // Reliability is never established from metadata.
      reliability: EVIDENCE_CONFIDENCE.INFERRED,
    };

    const values = Object.values(fieldConfidence);
    const confidence = values.reduce((a, b) => a + b, 0) / values.length;

    // If most of the profile had to be inferred, dotAI does not pretend to
    // know the model. It stays unassessed and out of recommendation.
    const inferredCount = values.filter((v) => v === EVIDENCE_CONFIDENCE.INFERRED).length;
    if (inferredCount >= 5) {
      return {
        assessed: false,
        reason: "Provider metadata is too sparse to establish a capability profile.",
        evidenceLevel: "INFERRED",
        confidence,
        fieldConfidence,
      };
    }

    return {
      assessed: true,
      profile,
      evidenceLevel: "DIRECT_PROVIDER_DATA",
      confidence: Math.round(confidence * 100) / 100,
      fieldConfidence,
    };
  }

  /**
   * Assesses every model that is still unassessed. Cheap by construction: it
   * reads stored metadata and calls no model, so it costs nothing to run.
   */
  async assessNewModels(limit = 1000): Promise<{
    examined: number; assessed: number; stillUnassessed: number;
  }> {
    // The queue covers everything not yet resolved: freshly synced models
    // (ASSESSMENT_PENDING) and earlier ones that lacked evidence.
    const rows = await prisma.model.findMany({
      where: {
        active: true,
        capability: { status: { in: ["ASSESSMENT_PENDING", "UNASSESSED"] } },
      },
      include: { modalities: true, capability: true },
      take: limit,
    });

    let assessed = 0;
    for (const row of rows) {
      const outcome = this.assess({
        openrouterModelId: row.openrouterModelId,
        contextLength: row.contextLength,
        inputModalities: row.modalities.filter((m) => m.direction === "INPUT").map((m) => m.modality),
        outputModalities: row.modalities.filter((m) => m.direction === "OUTPUT").map((m) => m.modality),
        supportedParameters: safeParams(row.supportedParameters),
        description: row.description,
      });

      if (!outcome.assessed || !outcome.profile) {
        // The model stays visible in the catalog. It is simply not eligible
        // for automatic recommendation until evidence exists.
        await prisma.modelCapability.update({
          where: { modelId: row.id },
          data: {
            status: "ASSESSMENT_FAILED",
            unassessedReason: outcome.reason ?? "Insufficient evidence.",
            assessmentVersion: ASSESSMENT_VERSION,
            lastEvaluatedAt: new Date(),
          },
        });
        continue;
      }

      await prisma.modelCapability.update({
        where: { modelId: row.id },
        data: {
          ...outcome.profile,
          outputCapabilities: JSON.stringify(outcome.profile.outputCapabilities),
          status: "ASSESSED",
          assessmentSource: "INITIAL",
          evidenceLevel: outcome.evidenceLevel,
          assessmentVersion: ASSESSMENT_VERSION,
          fieldConfidence: JSON.stringify(outcome.fieldConfidence),
          capabilityConfidence: outcome.confidence,
          unassessedReason: null,
          assessmentDate: new Date(),
          lastEvaluatedAt: new Date(),
        },
      });
      assessed++;
    }

    const stillUnassessed = await prisma.modelCapability.count({
      where: { status: { in: ["ASSESSMENT_PENDING", "UNASSESSED", "ASSESSMENT_FAILED"] } },
    });
    return { examined: rows.length, assessed, stillUnassessed };
  }

  /**
   * Reassesses one model. Manual reassessment always proceeds; automatic
   * reassessment is skipped unless something actually changed, so we do not
   * re-derive the same profile on every sync.
   */
  async reassessModel(
    openrouterModelId: string, opts: { force?: boolean } = {},
  ): Promise<AssessmentOutcome & { skipped?: boolean }> {
    const row = await prisma.model.findUnique({
      where: { openrouterModelId },
      include: { modalities: true, capability: true },
    });
    if (!row) {
      return {
        assessed: false, reason: "Model not found.", evidenceLevel: "INFERRED",
        confidence: 0, fieldConfidence: {},
      };
    }

    const versionChanged = row.capability?.assessmentVersion !== ASSESSMENT_VERSION;
    // A manual or benchmark assessment is not overwritten by an automatic pass.
    const humanOwned =
      row.capability?.assessmentSource === "MANUAL" ||
      row.capability?.assessmentSource === "BENCHMARK";

    if (!opts.force && humanOwned && !versionChanged) {
      return {
        assessed: true, skipped: true,
        reason: "Existing manual or benchmark assessment retained.",
        evidenceLevel: (row.capability?.evidenceLevel ?? "MANUAL_ASSESSMENT") as EvidenceLevel,
        confidence: row.capability?.capabilityConfidence ?? 0,
        fieldConfidence: {},
      };
    }

    const outcome = this.assess({
      openrouterModelId,
      contextLength: row.contextLength,
      inputModalities: row.modalities.filter((m) => m.direction === "INPUT").map((m) => m.modality),
      outputModalities: row.modalities.filter((m) => m.direction === "OUTPUT").map((m) => m.modality),
      supportedParameters: safeParams(row.supportedParameters),
      description: row.description,
    });

    if (outcome.assessed && outcome.profile) {
      await prisma.modelCapability.update({
        where: { modelId: row.id },
        data: {
          ...outcome.profile,
          outputCapabilities: JSON.stringify(outcome.profile.outputCapabilities),
          status: "ASSESSED",
          evidenceLevel: outcome.evidenceLevel,
          assessmentVersion: ASSESSMENT_VERSION,
          fieldConfidence: JSON.stringify(outcome.fieldConfidence),
          capabilityConfidence: outcome.confidence,
          unassessedReason: null,
          assessmentDate: new Date(),
          lastEvaluatedAt: new Date(),
        },
      });
    }
    return outcome;
  }
}

function safeParams(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export const modelAssessment = new ModelCapabilityAssessmentService();
