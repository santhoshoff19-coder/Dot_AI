export type { TaskRequirements } from "@/lib/routing/route-types";

export interface CAIInput {
  prompt: string;
  attachments?: import("@/types").AttachmentRef[];
  historyChars?: number;
  settings?: Partial<import("@/types").UserSettings>;
  /** Hints carried over from the Fast Router so CAI starts warm. */
  hint?: {
    taskType?: import("@/types").TaskType;
    complexity?: number;
    riskLevel?: import("@/types").RiskLevel;
    modalities?: import("@/types").Modality[];
  };
}
