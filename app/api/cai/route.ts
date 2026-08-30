import { NextRequest } from "next/server";
import { z } from "zod";
import { routeRequest } from "@/lib/routing/orchestrator";

export const runtime = "nodejs";

const Schema = z.object({
  prompt: z.string().min(1).max(20_000),
  attachments: z.array(z.object({
    id: z.string(), name: z.string(), mimeType: z.string(),
    size: z.number(), type: z.enum(["image", "document", "audio", "other"]),
  })).max(10).default([]),
});

export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json());
    return Response.json(await routeRequest({
      prompt: body.prompt,
      attachments: body.attachments.map((a) => ({
        ...a, previewUrl: null, storageRef: null, extractedText: null,
      })),
    }));
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }
}
