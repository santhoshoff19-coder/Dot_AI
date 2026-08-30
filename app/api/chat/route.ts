import { NextRequest } from "next/server";
import { z } from "zod";
import { runControlPlane } from "@/lib/controlplane";
import { auditService } from "@/lib/audit/service";
import { learningService } from "@/lib/learning/service";
import { modelFeedback } from "@/lib/models/feedback";
import { modelIntelligence } from "@/lib/models/intelligence";
import { prisma } from "@/lib/db";
import { conversationContext } from "@/lib/conversation/context";
import { library } from "@/lib/library/service";
import { currentUserId } from "@/lib/auth/identity";
import { ProviderError } from "@/lib/providers";
import type { StreamEvent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AttachmentSchema = z.object({
  id: z.string(),
  name: z.string().max(300),
  mimeType: z.string().max(200),
  size: z.number().int().nonnegative(),
  type: z.enum(["image", "document", "audio", "other"]),
  previewUrl: z.string().nullable().optional(),
  storageRef: z.string().nullable().optional(),
  extractedText: z.string().nullable().optional(),
  extractionStatus: z.string().nullable().optional(),
});

const BodySchema = z.object({
  prompt: z.string().min(1).max(20_000),
  conversationId: z.string().optional().nullable(),
  attachments: z.array(AttachmentSchema).max(10).default([]),
  destinationExternal: z.boolean().default(false),
  /** Model chosen by the user in the three-model chooser. */
  selectedModelId: z.string().optional(),
  outputPreference: z.enum(["AUTO", "TEXT", "IMAGE", "DOCUMENT"]).default("AUTO"),
  /** Set when this request came from a Library prompt, so usage is recorded. */
  libraryPromptId: z.string().optional(),
  ragMode: z.enum(["AUTO", "ON", "OFF"]).default("AUTO"),
  /** Which use case governs this request. */
  profileId: z.string().optional(),
  settings: z.object({
    autoMode: z.boolean().default(true),
    effort: z.enum(["AUTO", "low", "medium", "high"]).default("AUTO"),
    verification: z.enum(["AUTO", "STANDARD", "STRICT"]).default("AUTO"),
    costPreference: z.enum(["LOWEST", "BALANCED", "BEST_QUALITY"]).default("BALANCED"),
  }).partial().default({}),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: "Invalid request body.", detail: String(err) }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const requestId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };

      try {
        // --- conversation + user message -------------------------------
        let conversationId = body.conversationId ?? null;
        if (!conversationId) {
          const title = body.prompt.slice(0, 60) + (body.prompt.length > 60 ? "…" : "");
          const conv = await prisma.conversation.create({ data: { title } });
          conversationId = conv.id;
          send({ type: "conversation", id: conv.id, title: conv.title });
        }

        const userMessage = await prisma.message.create({
          data: {
            conversationId,
            role: "user",
            content: body.prompt,
            status: "complete",
            attachments: {
              create: body.attachments.map((a) => ({
                name: a.name, mimeType: a.mimeType, size: a.size,
                type: a.type, previewUrl: a.previewUrl ?? null,
                storageRef: a.storageRef ?? null,
                // Persisted so a later turn can refer back to this document.
                extractedText: a.extractedText ?? null,
                extractionStatus: a.extractionStatus ?? null,
              })),
            },
          },
        });

        // Recent turns verbatim, older turns compressed, plus references to
        // files shared earlier so a follow-up can say "that document".
        const context = await conversationContext.build(conversationId, {
          excludeMessageId: userMessage.id,
        });
        const history = conversationContext.toProviderHistory(context);

        // --- run the control loop ---------------------------------------
        const { answer, heldAnswer, image, document, controlEvent } = await runControlPlane(
          {
            requestId,
            prompt: body.prompt,
            attachments: body.attachments.map((a) => ({
              ...a,
              previewUrl: a.previewUrl ?? null,
              storageRef: a.storageRef ?? null,
              extractedText: a.extractedText ?? null,
              extractionStatus: a.extractionStatus ?? undefined,
            })),
            history,
            conversationContext: context,
            settings: body.settings,
            destinationExternal: body.destinationExternal,
            actor: {
              role: "support_agent",
              permissions: ["accounts.read", "mail.send", "refunds.write", "payments.approve"],
            },
            selectedModelId: body.selectedModelId,
            outputPreference: body.outputPreference,
            ragMode: body.ragMode,
            profileId: body.profileId,
            sessionId: conversationId,
            signal: req.signal,
          },
          send,
        );

        const decision = controlEvent.decision.decision;
        const status =
          decision === "BLOCK" ? "blocked" : decision === "HOLD" ? "held" : "complete";

        // A held answer is stored so the reviewer can see it; the UI keeps it
        // behind the review gate until a human approves.
        const storedContent = decision === "HOLD" ? heldAnswer : answer;

        const assistantMessage = await prisma.message.create({
          data: {
            conversationId, role: "assistant", content: storedContent, status,
            // A generated image is stored as an attachment row so it survives
            // a page reload and appears in history like any other artefact.
            ...(document
              ? {
                  attachments: {
                    create: [{
                      name: document.fileName,
                      mimeType: document.mimeType,
                      size: document.size,
                      type: "document",
                      previewUrl: document.url,
                      storageRef: document.url,
                    }],
                  },
                }
              : {}),
            ...(image
              ? {
                  attachments: {
                    create: [{
                      name: "generated-image",
                      mimeType: image.mimeType,
                      size: image.url.length,
                      type: "image",
                      previewUrl: image.url,
                      storageRef: null,
                    }],
                  },
                }
              : {}),
          },
        });

        // The image event is emitted by the control loop itself.

        await prisma.controlEvent.create({
          data: {
            messageId: assistantMessage.id,
            requestId: controlEvent.requestId,
            profileId: controlEvent.profileId ?? "BASELINE",
            taskType: controlEvent.taskClassification,
            complexity: controlEvent.complexity,
            recommendedModel: controlEvent.recommendedModel,
            selectedModel: controlEvent.selectedModel,
            provider: controlEvent.provider,
            effort: controlEvent.effort,
            estimatedCost: controlEvent.estimatedCost,
            actualCost: controlEvent.actualCost,
            inputTokens: controlEvent.cost.inputTokens,
            outputTokens: controlEvent.cost.outputTokens,
            performanceResult: controlEvent.verification.status,
            costResult: controlEvent.cost.status,
            responsibilityResult: controlEvent.responsibility.status,
            riskLevel: controlEvent.riskLevel,
            verificationDepth: controlEvent.verificationDepth,
            decision,
            reason: controlEvent.decision.reason,
            latencyMs: controlEvent.latencyMs,
            attempts: controlEvent.attempts,
            payload: JSON.stringify(controlEvent),
          },
        });

        await prisma.conversation.update({
          where: { id: conversationId }, data: { updatedAt: new Date() },
        });

        await auditService.record(controlEvent);
        await learningService.record(controlEvent);

        // Feedback loop: one outcome per generation, keyed to the model that
        // actually ran. This is the evidence capability revisions are built on.
        // A Library run records real usage, so "Recently Used" reflects
        // executions rather than frontend state.
        if (body.libraryPromptId) {
          try {
            await library.recordUsage(await currentUserId(), body.libraryPromptId, {
              filledPrompt: body.prompt,
              conversationId,
              requestId,
              selectedModel: controlEvent.selectedModel,
              success: controlEvent.decision.decision !== "BLOCK",
            });
          } catch (err) {
            console.error("[library] usage record failed", err);
          }
        }

        await modelIntelligence.ensureSeeded();
        await modelFeedback.recordOutcome({
          requestId,
          openrouterModelId: controlEvent.selectedModel,
          event: controlEvent,
        });

        send({ type: "control", event: controlEvent });
        send({
          type: "message",
          message: {
            id: assistantMessage.id,
            conversationId,
            role: "assistant",
            content: storedContent,
            status: status as "complete" | "blocked" | "held",
            createdAt: assistantMessage.createdAt.toISOString(),
            attachments: [],
            image: image ?? null,
            document: document ?? null,
            controlEvent,
          },
        });
        send({ type: "done" });
      } catch (err) {
        const message =
          err instanceof ProviderError
            ? err.message
            : `Something went wrong while processing this request. ${String(err)}`;
        console.error("[chat]", err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
