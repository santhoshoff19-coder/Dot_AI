import type {
  Level, OutputCapability, TaskRequirementProfile, ToolCapability,
} from "@/lib/capability/taxonomy";
import type { TaskRequirements } from "@/lib/routing/route-types";

/**
 * Bridges the existing routing pipeline to the controlled capability
 * vocabulary. Produces a TaskRequirementProfile deterministically from the
 * requirements the Fast Router or CAI already established, so nothing in the
 * pipeline has to invent taxonomy values.
 */
export function deriveRequirementProfile(req: TaskRequirements): TaskRequirementProfile {
  const band = (n: number): Level => (n >= 0.7 ? "HIGH" : n >= 0.35 ? "MEDIUM" : "LOW");

  const effort: Level =
    req.recommendedEffort === "high" ? "HIGH"
    : req.recommendedEffort === "medium" ? "MEDIUM" : "LOW";

  const reasoning: Level =
    req.reasoningRequirement === "heavy" ? "HIGH"
    : req.reasoningRequirement === "moderate" ? "MEDIUM" : "LOW";

  // Context handling is a normalised capability class, not the raw window size.
  const contextHandling: Level =
    req.contextRequirement > 60_000 ? "HIGH"
    : req.contextRequirement > 8_000 ? "MEDIUM" : "LOW";

  const instructionComplexity = band(req.complexity);

  // Reliability demanded of the model rises with the consequence of the task.
  const reliability: Level =
    req.riskLevel === "critical" || req.riskLevel === "high" ? "HIGH"
    : req.riskLevel === "medium" ? "MEDIUM" : "LOW";

  const toolCapability: ToolCapability =
    req.taskType === "tool_execution" ? "BASIC"
    : req.requiredCapabilities.includes("tools") ? "BASIC" : "NONE";

  const requiredInputModalities = req.modalities.map((m) =>
    m === "image" ? "IMAGE" : m === "audio" ? "AUDIO" : m === "document" ? "FILE" : "TEXT",
  );

  const requiredOutputModalities: OutputCapability[] =
    req.taskType === "image_generation" ? ["IMAGE"] : ["TEXT"];

  return {
    taskType: req.taskType,
    effort,
    reasoning,
    contextHandling,
    instructionComplexity,
    reliability,
    toolCapability,
    requiredInputModalities: [...new Set(requiredInputModalities)],
    requiredOutputModalities,
    confidence: req.confidence,
  };
}

export function complexityBand(n: number): Level {
  return n >= 0.7 ? "HIGH" : n >= 0.35 ? "MEDIUM" : "LOW";
}
