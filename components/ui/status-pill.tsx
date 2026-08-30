import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok border-ok/25",
  warn: "bg-warn/10 text-warn border-warn/25",
  danger: "bg-danger/10 text-danger border-danger/25",
  info: "bg-info/10 text-info border-info/25",
  accent: "bg-accent/10 text-accent-soft border-accent/25",
  neutral: "bg-elevated text-muted border-line",
};

export function StatusPill({
  children, tone = "neutral", className, icon,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        TONES[tone], className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export function toneForDecision(d: string): Tone {
  switch (d) {
    case "ALLOW": return "ok";
    case "ANNOTATE": return "info";
    case "REGENERATE": return "accent";
    case "HOLD": return "warn";
    case "BLOCK": return "danger";
    default: return "neutral";
  }
}

export function toneForStatus(s: string): Tone {
  switch (s) {
    case "SUPPORTED": case "PERMITTED": case "WITHIN TARGET": return "ok";
    case "UNCERTAIN": case "RESTRICTED": case "ABOVE TARGET": return "warn";
    case "CONTRADICTED": case "PROHIBITED": case "OVER BUDGET": return "danger";
    case "UNVERIFIABLE": return "neutral";
    default: return "neutral";
  }
}
