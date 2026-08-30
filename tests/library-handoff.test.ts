import { beforeEach, describe, expect, it, vi } from "vitest";
import { stageHandoff, takeHandoff } from "@/lib/library/handoff";
import type { AttachmentRef } from "@/types";

/** A minimal sessionStorage, since these tests run in node. */
function installSessionStorage() {
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return store;
}

const attachment = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a1",
  name: "invoice.pdf",
  mimeType: "application/pdf",
  size: 2048,
  type: "document",
  previewUrl: null,
  storageRef: "uploads/a1",
  extractedText: null,
  ...over,
});

describe("library to chat handoff", () => {
  beforeEach(() => { installSessionStorage(); });

  it("carries the filled prompt and its attachments", () => {
    stageHandoff({
      prompt: "Summarise invoice.pdf and list the totals.",
      attachments: [attachment()],
      libraryPromptId: "p1",
      outputModality: "TEXT",
    });

    const got = takeHandoff();
    expect(got?.prompt).toContain("Summarise");
    expect(got?.attachments).toHaveLength(1);
    expect(got?.attachments[0].name).toBe("invoice.pdf");
    expect(got?.libraryPromptId).toBe("p1");
  });

  it("carries a file, which a URL parameter could not", () => {
    // The previous handoff put the prompt in `?prompt=`; a file has no
    // representation there at all.
    stageHandoff({
      prompt: "Describe {IMAGE}.",
      attachments: [attachment({ id: "i1", name: "photo.png", mimeType: "image/png", type: "image" })],
      libraryPromptId: "p2",
    });
    const got = takeHandoff();
    expect(got?.attachments[0].type).toBe("image");
    expect(got?.attachments[0].storageRef).toBeTruthy();
  });

  it("is consumed exactly once", () => {
    stageHandoff({ prompt: "hello", attachments: [], libraryPromptId: "p3" });

    expect(takeHandoff()?.prompt).toBe("hello");
    // A second read must be empty, or returning to chat would refill the
    // composer every time.
    expect(takeHandoff()).toBeNull();
  });

  it("returns nothing when none was staged", () => {
    expect(takeHandoff()).toBeNull();
  });

  it("ignores a stale payload rather than replaying it", () => {
    vi.useFakeTimers();
    try {
      stageHandoff({ prompt: "old", attachments: [], libraryPromptId: "p4" });
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(takeHandoff()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives corrupted storage without throwing", () => {
    sessionStorage.setItem("dotai:library-handoff", "{not json");
    expect(takeHandoff()).toBeNull();

    sessionStorage.setItem("dotai:library-handoff", JSON.stringify({ nope: 1 }));
    expect(takeHandoff()).toBeNull();
  });

  it("defaults attachments to an empty list when absent", () => {
    sessionStorage.setItem("dotai:library-handoff", JSON.stringify({
      prompt: "text only", libraryPromptId: "p5", createdAt: Date.now(),
    }));
    const got = takeHandoff();
    expect(got?.attachments).toEqual([]);
  });

  it("reports failure instead of throwing when storage is unavailable", () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceeded"); },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage;

    expect(stageHandoff({ prompt: "x", attachments: [], libraryPromptId: "p6" })).toBe(false);
  });

  it("never carries an instruction to send", () => {
    // The staged payload describes what to load, never what to do with it.
    // Sending is the user's action; a flag here would make it the app's.
    stageHandoff({ prompt: "run me", attachments: [], libraryPromptId: "p7" });
    const got = takeHandoff() as Record<string, unknown> | null;

    expect(got).toBeTruthy();
    expect(Object.keys(got!).sort()).toEqual(
      ["attachments", "createdAt", "libraryPromptId", "outputModality", "prompt"]
        .filter((k) => k in got!).sort(),
    );
    expect("send" in got!).toBe(false);
    expect("autoSend" in got!).toBe(false);
  });
});
