import type { AttachmentRef } from "@/types";

/**
 * The Library → Chat handoff.
 *
 * A filled prompt used to travel as a URL query parameter, which chat never
 * read - so nothing arrived. It also cannot carry an uploaded file. This
 * stages both in sessionStorage instead: the Library uploads the file through
 * the normal attachment endpoint, stashes the resulting reference alongside
 * the filled text, and Chat picks it up on mount.
 *
 * The staged payload is *prefilled, never sent*. Choosing a conversation is
 * navigation, not consent to run a model - the user still presses send.
 */

const KEY = "dotai:library-handoff";

export interface LibraryHandoff {
  prompt: string;
  attachments: AttachmentRef[];
  libraryPromptId: string;
  /** The stored output modality, so chat can preselect its output control. */
  outputModality?: string;
  /** Guards against replaying a stale payload after a reload. */
  createdAt: number;
}

/** How long a staged handoff stays valid. */
const TTL_MS = 5 * 60 * 1000;

export function stageHandoff(
  handoff: Omit<LibraryHandoff, "createdAt">,
): boolean {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...handoff, createdAt: Date.now() }));
    return true;
  } catch {
    // Private browsing or a full quota. The caller falls back to sending the
    // prompt text alone rather than losing the action entirely.
    return false;
  }
}

/**
 * Reads and clears the staged handoff.
 *
 * Consumed exactly once: leaving it in place would refill the composer every
 * time the user returned to chat, which reads as the app typing at them.
 */
export function takeHandoff(): LibraryHandoff | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);

    const parsed = JSON.parse(raw) as LibraryHandoff;
    if (!parsed?.prompt || typeof parsed.prompt !== "string") return null;
    if (Date.now() - (parsed.createdAt ?? 0) > TTL_MS) return null;

    return {
      prompt: parsed.prompt,
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      libraryPromptId: parsed.libraryPromptId ?? "",
      outputModality: parsed.outputModality,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}
