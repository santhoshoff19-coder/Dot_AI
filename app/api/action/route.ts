import { NextRequest } from "next/server";
import { z } from "zod";
import { actionGate } from "@/lib/action-gate/service";
import { auditService } from "@/lib/audit/service";
import { learningService } from "@/lib/learning/service";
import { modelFeedback } from "@/lib/models/feedback";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReviewSchema = z.object({
  messageId: z.string(),
  requestId: z.string(),
  humanDecision: z.enum(["approve", "reject", "edit", "regenerate"]),
  note: z.string().max(2000).optional(),
  editedContent: z.string().max(20_000).optional(),
});

/** Human review resolution. Every human decision is logged. */
export async function POST(req: NextRequest) {
  let body: z.infer<typeof ReviewSchema>;
  try {
    body = ReviewSchema.parse(await req.json());
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }

  try {
    const message = await prisma.message.findUnique({
      where: { id: body.messageId }, include: { controlEvent: true },
    });
    if (!message) return Response.json({ error: "Message not found." }, { status: 404 });

    let status = message.status;
    let content = message.content;

    if (body.humanDecision === "approve") {
      // The held answer is already stored on the message; approving simply
      // releases it.
      status = "complete";
    } else if (body.humanDecision === "reject") {
      status = "blocked";
      content = "";
    } else if (body.humanDecision === "edit") {
      status = "complete";
      content = body.editedContent ?? content;
    }

    await prisma.message.update({
      where: { id: body.messageId }, data: { status, content },
    });

    await auditService.recordHumanDecision(body.requestId, body.humanDecision);
    // A human overruling the checker is the strongest signal available, in
    // both directions: it is recorded as a false negative or false positive.
    await modelFeedback.attachHumanDecision(body.requestId, body.humanDecision);
    if (message.controlEvent?.selectedModel) {
      await learningService.markHumanOverride(message.controlEvent.selectedModel);
    }

    return Response.json({ ok: true, status, content });
  } catch (err) {
    return Response.json({ error: "Review failed.", detail: String(err) }, { status: 500 });
  }
}

/** Dry-run the Action Gate for a proposed action. */
export async function PUT(req: NextRequest) {
  const Schema = z.object({
    name: z.string(),
    valueUsd: z.number().default(0),
    external: z.boolean().default(false),
    permissions: z.array(z.string()).default(["accounts.read", "mail.send", "refunds.write"]),
  });
  try {
    const body = Schema.parse(await req.json());
    const result = actionGate.evaluate(
      {
        name: body.name, parameters: {}, valueUsd: body.valueUsd,
        reversible: false, destination: { channel: "api", external: body.external },
      },
      { role: "support_agent", permissions: body.permissions },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: "Invalid request.", detail: String(err) }, { status: 400 });
  }
}
