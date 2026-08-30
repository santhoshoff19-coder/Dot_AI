import type { ModelSpec } from "@/types";

/**
 * Model fixtures for tests of the legacy scoring and orchestrator code.
 *
 * These used to be production seed data - three fixed models named "Swift",
 * "Balanced" and "Deep" bound to specific ids. They were removed because they
 * leaked into the product: the Settings page offered them as fixed choices,
 * and the chat cards fell back to them for every query.
 *
 * The subsystems that scored them still deserve tests, so the fixtures live
 * here instead. Names are deliberately generic - they describe the shape of a
 * candidate, and nothing outside these tests may depend on them.
 */
export const TEST_MODELS: ModelSpec[] = [
  {
    id: "test/fast-cheap",
    provider: "test",
    name: "Fast Cheap",
    capabilities: ["text", "vision", "tools"],
    inputCost: 0.15,
    outputCost: 0.6,
    contextLimit: 128_000,
    modalities: ["text", "image"],
    reasoningSupport: false,
    relativeCapability: 0.62,
    latencyClass: "fast",
    enabled: true,
    skills: {
      conversation: 0.96, summarization: 0.9, extraction: 0.91,
      classification: 0.93, translation: 0.92, formatting: 0.95,
      image_generation: 0.05, writing: 0.86, coding: 0.62, reasoning: 0.55,
      complex_reasoning: 0.3, data_analysis: 0.58, image_analysis: 0.78,
      document_analysis: 0.8, tool_execution: 0.66,
    },
  },
  {
    id: "test/mid-capable",
    provider: "test",
    name: "Mid Capable",
    capabilities: ["text", "vision", "reasoning", "long_context", "coding", "tools"],
    inputCost: 3,
    outputCost: 15,
    contextLimit: 200_000,
    modalities: ["text", "image", "document"],
    reasoningSupport: true,
    relativeCapability: 0.88,
    latencyClass: "balanced",
    enabled: true,
    skills: {
      conversation: 0.97, summarization: 0.95, extraction: 0.95,
      classification: 0.95, translation: 0.96, formatting: 0.97,
      image_generation: 0.05, writing: 0.94, coding: 0.9, reasoning: 0.88,
      complex_reasoning: 0.75, data_analysis: 0.88, image_analysis: 0.89,
      document_analysis: 0.93, tool_execution: 0.9,
    },
  },
  {
    id: "test/slow-strong",
    provider: "test",
    name: "Slow Strong",
    capabilities: ["text", "vision", "reasoning", "long_context", "coding"],
    inputCost: 15,
    outputCost: 60,
    contextLimit: 200_000,
    modalities: ["text", "image", "document"],
    reasoningSupport: true,
    relativeCapability: 0.97,
    latencyClass: "slow",
    enabled: true,
    skills: {
      conversation: 0.95, summarization: 0.96, extraction: 0.96,
      classification: 0.96, translation: 0.97, formatting: 0.97,
      image_generation: 0.05, writing: 0.95, coding: 0.96, reasoning: 0.97,
      complex_reasoning: 0.95, data_analysis: 0.95, image_analysis: 0.9,
      document_analysis: 0.95, tool_execution: 0.93,
    },
  },
];
