import { prisma } from "@/lib/db";
import { embeddingService } from "@/lib/policy/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-embeds every stored chunk with the current embedding model.
 *
 * Needed whenever the embedding model changes: vectors from different models
 * are not comparable, so a mixed corpus silently degrades retrieval.
 */
export async function POST() {
  const started = Date.now();
  try {
    const chunks = await prisma.policyChunk.findMany({
      select: { id: true, text: true, embeddingModel: true },
    });
    if (chunks.length === 0) {
      return Response.json({ reindexed: 0, model: "none", durationMs: 0 });
    }

    const probe = await embeddingService.embed([chunks[0].text]);
    let reindexed = 0;

    // Batched so a large corpus does not hold everything in memory at once.
    const BATCH = 32;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const result = await embeddingService.embed(slice.map((c) => c.text));
      for (let j = 0; j < slice.length; j++) {
        await prisma.policyChunk.update({
          where: { id: slice[j].id },
          data: {
            embedding: JSON.stringify(result.vectors[j] ?? []),
            embeddingModel: result.model,
          },
        });
        reindexed++;
      }
    }

    return Response.json({
      reindexed, model: probe.model, mode: probe.mode,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    return Response.json({ error: "Reindex failed.", detail: String(err) }, { status: 500 });
  }
}
