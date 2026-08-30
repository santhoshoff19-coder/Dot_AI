import { NextRequest } from "next/server";
import {
  allListB, curatedDataset, eqForm, inputForms, intelligenceFor,
  modelById, outputFormsFor, subTasksForForms,
} from "@/lib/intelligence/curated-dataset";
import { blendedCost } from "@/lib/intelligence/curated-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Model Intelligence, served from the curated dataset only.
 *
 * No OpenRouter call is made here. The taxonomy, the models, their costs,
 * their per-sub-task intelligence and their verified capability counts all
 * come from the static workbook.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const input = p.get("input") ?? "Text";
  const output = p.get("output") ?? "Text";
  const subTask = p.get("subTask") ?? "";

  try {
    const data = curatedDataset();
    const listBs = allListB();
    const models = modelById();

    const inputs = inputForms().map((i) => ({ id: i, label: i }));
    const outputsByInput = Object.fromEntries(inputForms().map((i) => [
      i, outputFormsFor(i).map((o) => ({ id: o, label: o })),
    ]));
    const subTasksByPair = Object.fromEntries(
      data.subTasks.map((s) => [`${s.input}>${s.output}`, [] as { id: string; label: string }[]]));
    for (const s of data.subTasks) {
      subTasksByPair[`${s.input}>${s.output}`].push({ id: s.id, label: s.name });
    }

    const chosen = subTasksForForms(input, output).find((s) => s.id === subTask)
      ?? subTasksForForms(input, output)[0];

    const rows = (chosen ? data.intelligence.filter((i) => i.subTaskId === chosen.id) : [])
      .map((i) => {
        const m = models.get(i.modelId);
        if (!m) return null;
        return {
          modelId: i.modelId,
          name: m.name,
          company: m.company,
          openrouterId: m.openrouterId,
          trusted: m.trusted,
          inputCost: i.inputCost,
          outputCost: i.outputCost,
          intelligence: i.intelligence,
          blendedCost: blendedCost(i.inputCost, i.outputCost),
          verifiedCount: listBs.get(i.modelId)?.size ?? 0,
          tradeoff: m.tradeoff,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      // Cheapest first: the ordering the routing layer uses, so the page and
      // the router agree about what "Recommended" would mean here.
      .sort((a, b) => a.blendedCost - b.blendedCost || b.intelligence - a.intelligence);

    return Response.json({
      inputs, outputsByInput, subTasksByPair, rows,
      meta: data.meta,
      notice: chosen
        ? `${chosen.name} · cheapest first · ${eqForm(input, chosen.input) ? "" : ""}`.trim()
        : "This input and output combination has no sub-task in the taxonomy.",
    });
  } catch (err) {
    return Response.json(
      { error: "Could not read the curated dataset.", detail: String(err) },
      { status: 500 });
  }
}
