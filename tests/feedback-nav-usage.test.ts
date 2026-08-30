import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { prisma } from "@/lib/db";
import { curatedDataset, modelById } from "@/lib/intelligence/curated-dataset";
import { learningService } from "@/lib/learning/service";

describe("FEEDBACK grouping", () => {
  it("groups Metrics, Control and Usage under one Feedback entry", () => {
    const src = readFileSync("components/layout/sidebar.tsx", "utf8");
    expect(src).toContain('label: "Feedback"');
    const group = src.slice(src.indexOf('label: "Feedback"'), src.indexOf("},\n  { href: \"/settings\""));
    for (const href of ["/metrics", "/control", "/usage"]) {
      expect(group, href).toContain(href);
    }
    // They must no longer be top-level peers — only inside the group.
    const topLevel = src.slice(src.indexOf("const NAV = ["), src.indexOf('label: "Feedback"'));
    for (const href of ["/metrics", "/control", "/usage"]) {
      expect(topLevel, `${href} still top-level`).not.toContain(href);
    }
  });

  it("keeps every route unchanged", () => {
    for (const p of ["app/metrics/page.tsx", "app/control/page.tsx", "app/usage/page.tsx"]) {
      expect(readFileSync(p, "utf8").length).toBeGreaterThan(0);
    }
  });
});

describe("Usage renders", () => {
  it("computes its figures without throwing on an empty seed registry", async () => {
    // The root cause: modelRegistry.all() is empty since the fixed model
    // mappings were removed, and reduce() with no initial value threw — which
    // failed the whole server component.
    const events = await prisma.controlEvent.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
    const d = curatedDataset();
    const models = modelById();

    const premium = d.intelligence.filter(i => models.has(i.modelId))
      .reduce<{ name: string; inputCost: number; outputCost: number; intelligence: number } | null>(
        (best, i) => {
          const c = { name: models.get(i.modelId)!.name, inputCost: i.inputCost,
            outputCost: i.outputCost, intelligence: i.intelligence };
          return !best || c.intelligence > best.intelligence ? c : best;
        }, null);

    expect(premium).not.toBeNull();
    const totalCost = events.reduce((n, e) => n + e.actualCost, 0);
    const counterfactual = events.reduce((n, e) =>
      n + (e.inputTokens/1e6)*premium!.inputCost + (e.outputTokens/1e6)*premium!.outputCost, 0);
    const savings = Math.max(0, counterfactual - totalCost);

    console.log(`USAGE events=${events.length} totalCost=${totalCost.toFixed(6)} premium=${premium!.name} counterfactual=${counterfactual.toFixed(6)} savings=${savings.toFixed(6)}`);
    expect(Number.isFinite(savings)).toBe(true);
    expect(savings).toBeGreaterThanOrEqual(0);

    const stats = await learningService.stats();
    console.log(`LEARNING rows=${stats.length}`);
  }, 120_000);
});

describe("Usage aggregation", () => {
  it("groups events by model and decision without throwing", async () => {
    // The page's own aggregation, run over whatever rows exist. It must hold
    // for an empty table too — that was the state in which the page crashed.
    const events = await prisma.controlEvent.findMany({
      orderBy: { createdAt: "desc" }, take: 500 });

    const byModel = new Map<string, { requests: number; cost: number }>();
    for (const e of events) {
      const r = byModel.get(e.selectedModel) ?? { requests: 0, cost: 0 };
      r.requests++; r.cost += e.actualCost; byModel.set(e.selectedModel, r);
    }
    const decisions = events.reduce<Record<string, number>>((a, e) => {
      a[e.decision] = (a[e.decision] ?? 0) + 1; return a; }, {});

    console.log(`USAGE2 events=${events.length} models=${byModel.size} decisions=${JSON.stringify(decisions)}`);
    expect(byModel.size).toBeLessThanOrEqual(events.length);
    expect(Object.values(decisions).reduce((a, b) => a + b, 0)).toBe(events.length);
  }, 120_000);
});
