import { OwnershipError, ValidationError } from "@/lib/library/service";

/**
 * Maps a Library error onto a response. Ownership failures return 404 rather
 * than 403, so the existence of another user's prompt is never confirmed.
 */
export function handleError(err: unknown) {
  if (err instanceof ValidationError) {
    return Response.json({ error: err.message, detail: err.detail }, { status: 400 });
  }
  if (err instanceof OwnershipError) {
    return Response.json({ error: err.message }, { status: 404 });
  }
  console.error("[library]", err);
  // Never surface a stack trace or internals to the client.
  return Response.json({ error: "Request failed." }, { status: 500 });
}
