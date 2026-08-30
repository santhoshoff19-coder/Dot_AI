# Static benchmark seed format

The importer (`lib/intelligence/benchmark-import.ts`) reads this shape. Post it
to `POST /api/intelligence/matrix` as `{ "seed": <this object> }`.

Importing is idempotent. The key is `(taskId, modelId, endpointType)`, so
re-running updates rather than duplicates.

```jsonc
{
  "version": "benchmark-2026.1",
  "benchmarkDate": "2026-01-15",       // when the benchmark was compiled
  "tasks": [
    {
      "taskId": "CODING",              // must match lib/intelligence/taxonomy.ts
      "candidateTarget": 10,
      "rows": [
        {
          "modelId": "google/gemini-2.5-flash",  // exact OpenRouter ID, never a display name
          "endpointType": "chat",                // chat | images | videos | audio

          // Every field carries a status. Values are 0-100.
          "taskIntelligence": { "value": 94, "status": "BENCHMARK" },
          "quality":          { "value": 91, "status": "BENCHMARK" },
          "reliability":      { "status": "UNKNOWN" },   // no value = no number stored
          "latency":          { "value": 70, "status": "INFERRED" },
          "contextCapacity":  { "value": 88, "status": "VERIFIED" },
          "capabilityFit":    { "value": 100, "status": "VERIFIED" },
          "outputCompliance": { "value": 88, "status": "ESTIMATED" },

          // Static pricing is preserved as history. Live OpenRouter pricing
          // supersedes it for routing.
          "llmCost": {
            "input":  { "value": 0.15, "unit": "USD_PER_MILLION_TOKENS", "status": "BENCHMARK" },
            "output": { "value": 0.60, "unit": "USD_PER_MILLION_TOKENS", "status": "BENCHMARK" }
          },

          "sourceNote": "vendor documentation"
        }
      ]
    }
  ]
}
```

## Field statuses

| Status | Meaning | Ranked? |
|---|---|---|
| `VERIFIED` | Measured by dotAI, or a live catalog fact | yes |
| `BENCHMARK` | Published or vendor-stated figure | yes |
| `ESTIMATED` | Considered estimate | yes |
| `INFERRED` | Derived from an adjacent fact | yes |
| `UNKNOWN` | No evidence | **no** |
| `NOT_APPLICABLE` | Field does not apply to this task | **no** |

## Billing units

`USD_PER_MILLION_TOKENS`, `USD_PER_IMAGE`, `USD_PER_SECOND`, `USD_PER_MINUTE`,
`USD_PER_MEGAPIXEL`, `USD_PER_REQUEST`, `NOT_APPLICABLE`, `UNKNOWN`.

Each side of a price carries its own unit. An image generator's input side is
`NOT_APPLICABLE`; a speech-to-text model's output side usually is too.

## Rules the importer enforces

- A row whose `modelId` is not in the live catalog is **not created**; the ID is
  returned under `modelsNotInCatalog`.
- A `taskId` outside the taxonomy is **not created**; it is returned under
  `tasksUnknown`.
- A row that already carries dotAI observations (`sampleCount > 0`) is **never
  overwritten** — a measurement outranks a benchmark.
- A status claiming knowledge with no number behind it is stored as `UNKNOWN`.
- A field the task cannot have is forced to `NOT_APPLICABLE` regardless of what
  the seed claims (context capacity on image generation, for example).
- `costEfficiency` is never imported. It is derived at runtime from the current
  price, quality, reliability and expected retries.
