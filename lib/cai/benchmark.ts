import { prisma } from "@/lib/db";
import { caiService } from "@/lib/cai/service";
import { modelRegistry } from "@/lib/models/registry";
import { getProvider, isMockMode } from "@/lib/providers";
import type { Level, OutputCapability, TaskRequirementProfile, ToolCapability } from "@/lib/capability/taxonomy";

export const BENCHMARK_VERSION = "v1";

/** Quality bars a CAI candidate must clear. Cost alone never wins. */
export const CAI_THRESHOLDS = {
  MIN_CAI_ACCURACY: Number(process.env.MIN_CAI_ACCURACY ?? 0.75),
  MIN_CAI_SCHEMA_SUCCESS: Number(process.env.MIN_CAI_SCHEMA_SUCCESS ?? 0.95),
  MAX_CAI_LATENCY_MS: Number(process.env.MAX_CAI_LATENCY ?? 4000),
  MAX_CAI_COST_PER_REQUEST: Number(process.env.MAX_CAI_COST_PER_REQUEST ?? 0.0005),
};

export interface BenchmarkCase {
  id: string;
  prompt: string;
  band: "simple" | "medium" | "complex" | "multimodal" | "edge";
  expected: {
    taskType: string;
    reasoning: Level;
    reliability: Level;
    toolCapability?: ToolCapability;
    requiredOutputModalities: OutputCapability[];
  };
}

/**
 * A small, representative routing benchmark. It is deliberately compact and
 * extensible rather than exhaustive: its purpose is to separate a CAI that
 * classifies reliably from one that is merely cheap.
 */
export const BENCHMARK_CASES: BenchmarkCase[] = [
  // --- simple -------------------------------------------------------------
  { id: "s1", prompt: "Summarize this 500-word article.", band: "simple",
    expected: { taskType: "summarization", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "s2", prompt: "Translate this paragraph to French.", band: "simple",
    expected: { taskType: "translation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "s3", prompt: "Rewrite this sentence more formally.", band: "simple",
    expected: { taskType: "conversation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "s4", prompt: "Extract the invoice dates from this text.", band: "simple",
    expected: { taskType: "extraction", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "s5", prompt: "Classify the sentiment of this review.", band: "simple",
    expected: { taskType: "classification", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "s6", prompt: "Convert this list to JSON.", band: "simple",
    expected: { taskType: "formatting", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },

  // --- medium -------------------------------------------------------------
  { id: "m1", prompt: "Analyse this quarterly sales table and explain the biggest movement.", band: "medium",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "MEDIUM", requiredOutputModalities: ["TEXT"] } },
  { id: "m2", prompt: "Refactor this Python function to remove the nested loops and add type hints.", band: "medium",
    expected: { taskType: "coding", reasoning: "MEDIUM", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "m3", prompt: "Write a customer email that apologises, explains the delay, and offers two remedies.", band: "medium",
    expected: { taskType: "writing", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "m4", prompt: "Summarize this contract and list every obligation with its deadline.", band: "medium",
    expected: { taskType: "summarization", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },

  // --- complex ------------------------------------------------------------
  { id: "c1", prompt: "Analyze this acquisition proposal, compare the financial assumptions and recommend whether we should proceed.", band: "complex",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "HIGH", requiredOutputModalities: ["TEXT"] } },
  { id: "c2", prompt: "Review these financial statements and identify inconsistencies between the cash flow and the income statement.", band: "complex",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "HIGH", requiredOutputModalities: ["TEXT"] } },
  { id: "c3", prompt: "Approve a $50,000 payment to the vendor on file.", band: "complex",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "HIGH", requiredOutputModalities: ["TEXT"] } },
  { id: "c4", prompt: "Work through the second-order effects of this pricing change and where the strategy might break down.", band: "complex",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },

  // --- multimodal ---------------------------------------------------------
  { id: "x1", prompt: "Generate a cinematic image of a cat sitting on the moon.", band: "multimodal",
    expected: { taskType: "image_generation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["IMAGE"] } },
  { id: "x2", prompt: "Create an illustration of a lighthouse in a storm.", band: "multimodal",
    expected: { taskType: "image_generation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["IMAGE"] } },
  { id: "x3", prompt: "Draw a logo for a coffee shop called Ember.", band: "multimodal",
    expected: { taskType: "image_generation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["IMAGE"] } },

  // --- edge cases ---------------------------------------------------------
  { id: "e1", prompt: "Hello", band: "edge",
    expected: { taskType: "conversation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "e2", prompt: "Do the thing we discussed.", band: "edge",
    expected: { taskType: "conversation", reasoning: "LOW", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
  { id: "e3", prompt: "Summarize this but also decide whether we should proceed and draft the reply.", band: "edge",
    expected: { taskType: "complex_reasoning", reasoning: "HIGH", reliability: "LOW", requiredOutputModalities: ["TEXT"] } },
];

export interface CandidateResult {
  modelId: string;
  accuracy: number;
  fieldAccuracy: number;
  schemaSuccessRate: number;
  averageLatencyMs: number;
  averageCost: number;
  failureRate: number;
  meetsThresholds: boolean;
  rejectionReason?: string;
  selected: boolean;
}

export interface BenchmarkReport {
  benchmarkVersion: string;
  mode: "MOCK" | "LIVE";
  caseCount: number;
  results: CandidateResult[];
  selectedModelId: string | null;
  notes: string;
}

function scoreProfile(actual: TaskRequirementProfile, expected: BenchmarkCase["expected"]) {
  const taskMatch = actual.taskType === expected.taskType;
  const checks = [
    actual.reasoning === expected.reasoning,
    actual.reliability === expected.reliability,
    expected.toolCapability ? actual.toolCapability === expected.toolCapability : true,
    expected.requiredOutputModalities.every((m) => actual.requiredOutputModalities.includes(m)) &&
      actual.requiredOutputModalities.length === expected.requiredOutputModalities.length,
    taskMatch,
  ];
  return {
    taskMatch,
    fieldScore: checks.filter(Boolean).length / checks.length,
  };
}

export class CAIBenchmarkService {
  /**
   * Runs the suite against each candidate.
   *
   * In mock mode no provider is reachable, so the deterministic classifier is
   * measured instead. That is a genuine measurement of the fallback path, but
   * it is NOT evidence about a real model - the report is marked MOCK so no
   * one mistakes it for one.
   */
  async run(candidates: string[]): Promise<BenchmarkReport> {
    const mock = isMockMode();
    const results: CandidateResult[] = [];

    for (const modelId of candidates) {
      const spec = modelRegistry.get(modelId);
      let taskMatches = 0;
      let fieldTotal = 0;
      let schemaOk = 0;
      let failures = 0;
      let latencyTotal = 0;
      let costTotal = 0;

      for (const c of BENCHMARK_CASES) {
        const started = Date.now();
        try {
          let profile: TaskRequirementProfile;
          let valid = true;
          let cost = 0;

          if (mock || !spec) {
            profile = caiService.classify({ prompt: c.prompt });
          } else {
            const provider = getProvider();
            const out = await provider.generate({
              prompt: `${(await import("@/lib/cai/service")).CAI_SYSTEM_PROMPT}\n\nRequest to classify:\n"""${c.prompt}"""`,
              modelId, effort: "low", attachments: [], history: [],
            });
            cost = out.cost;
            const parsed = caiService.validate(out.text);
            if (parsed.ok) {
              profile = parsed.value;
            } else {
              valid = false;
              profile = caiService.classify({ prompt: c.prompt });
            }
          }

          if (valid) schemaOk++;
          const { taskMatch, fieldScore } = scoreProfile(profile, c.expected);
          if (taskMatch) taskMatches++;
          fieldTotal += fieldScore;
          costTotal += cost;
        } catch {
          failures++;
          fieldTotal += 0;
        }
        latencyTotal += Date.now() - started;
      }

      const n = BENCHMARK_CASES.length;
      const accuracy = taskMatches / n;
      const fieldAccuracy = fieldTotal / n;
      const schemaSuccessRate = schemaOk / n;
      const averageLatencyMs = latencyTotal / n;
      const averageCost = costTotal / n;
      const failureRate = failures / n;

      const reasons: string[] = [];
      if (accuracy < CAI_THRESHOLDS.MIN_CAI_ACCURACY) {
        reasons.push(`accuracy ${(accuracy * 100).toFixed(0)}% below the ${(CAI_THRESHOLDS.MIN_CAI_ACCURACY * 100).toFixed(0)}% floor`);
      }
      if (schemaSuccessRate < CAI_THRESHOLDS.MIN_CAI_SCHEMA_SUCCESS) {
        reasons.push(`schema validity ${(schemaSuccessRate * 100).toFixed(0)}% below floor`);
      }
      if (averageLatencyMs > CAI_THRESHOLDS.MAX_CAI_LATENCY_MS) {
        reasons.push(`latency ${averageLatencyMs.toFixed(0)}ms above budget`);
      }
      if (averageCost > CAI_THRESHOLDS.MAX_CAI_COST_PER_REQUEST) {
        reasons.push(`cost $${averageCost.toFixed(6)} above budget`);
      }

      results.push({
        modelId, accuracy, fieldAccuracy, schemaSuccessRate,
        averageLatencyMs, averageCost, failureRate,
        meetsThresholds: reasons.length === 0,
        rejectionReason: reasons.length ? reasons.join("; ") : undefined,
        selected: false,
      });
    }

    // The cheapest candidate that clears every quality bar wins. A cheaper
    // model that misclassifies is not a saving.
    const eligible = results.filter((r) => r.meetsThresholds);
    const winner = eligible.sort(
      (a, b) => a.averageCost - b.averageCost || b.accuracy - a.accuracy,
    )[0];
    if (winner) winner.selected = true;

    const report: BenchmarkReport = {
      benchmarkVersion: BENCHMARK_VERSION,
      mode: mock ? "MOCK" : "LIVE",
      caseCount: BENCHMARK_CASES.length,
      results,
      selectedModelId: winner?.modelId ?? null,
      notes: mock
        ? "Mock mode: the deterministic classifier was measured, not a live model. These numbers are not evidence about any provider model."
        : "Live mode: candidates were called through OpenRouter.",
    };

    await this.persist(report);
    return report;
  }

  private async persist(report: BenchmarkReport): Promise<void> {
    try {
      const run = await prisma.cAIBenchmarkRun.create({
        data: {
          benchmarkVersion: report.benchmarkVersion,
          caseCount: report.caseCount,
          mode: report.mode,
          selectedModelId: report.selectedModelId,
          notes: report.notes,
        },
      });
      await prisma.cAIBenchmarkResult.createMany({
        data: report.results.map((r) => ({
          runId: run.id,
          modelId: r.modelId,
          accuracy: r.accuracy,
          fieldAccuracy: r.fieldAccuracy,
          schemaSuccessRate: r.schemaSuccessRate,
          averageLatencyMs: r.averageLatencyMs,
          averageCost: r.averageCost,
          failureRate: r.failureRate,
          meetsThresholds: r.meetsThresholds,
          selected: r.selected,
          rejectionReason: r.rejectionReason ?? null,
        })),
      });
    } catch (err) {
      console.error("[cai-benchmark] persist failed", err);
    }
  }

  async latest() {
    return prisma.cAIBenchmarkRun.findFirst({
      orderBy: { createdAt: "desc" }, include: { results: true },
    });
  }
}

export const caiBenchmark = new CAIBenchmarkService();
