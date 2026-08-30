"use client";

import { Check } from "lucide-react";
import * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { OpenRouterConnect } from "@/components/settings/openrouter-connect";
import { loadSettings, saveSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { DEFAULT_SETTINGS, type UserSettings } from "@/types";

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<UserSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => { setSettings(loadSettings()); }, []);

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  };


  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Preferences apply to new requests." />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-2xl space-y-7">
          <OpenRouterConnect />

          <Group
            label="Routing mode"
            hint="Auto runs the recommended model. Choose shows three options before generating."
          >
            <Choice
              active={settings.autoMode}
              onClick={() => update("autoMode", true)}
              title="AUTO"
              subtitle="Run the recommendation"
            />
            <Choice
              active={!settings.autoMode}
              onClick={() => update("autoMode", false)}
              title="CHOOSE MODEL"
              subtitle="Show three options first"
            />
          </Group>

          {/*
            Cost preference, not model preference.

            This group used to list three fixed models by placeholder name and
            pin every request to whichever was chosen. Pinning defeats
            capability matching - the pinned model may not be able to do what
            a query needs, and the user has no way to know. This shapes how
            cost is weighed among the models that can actually do the job.
          */}
          <Group
            label="Cost preference"
            hint="How to weigh cost against capability among the models able to perform your query. CAI still decides which models are eligible."
          >
            {([
              ["LOWEST", "Lowest cost", "Cheapest model that can do the job"],
              ["BALANCED", "Balanced", "Recommended"],
              ["BEST_QUALITY", "Best quality", "Prefer capability over cost"],
            ] as const).map(([value, title, subtitle]) => (
              <Choice
                key={value}
                active={settings.costPreference === value}
                onClick={() => update("costPreference", value)}
                title={title}
                subtitle={subtitle}
              />
            ))}
          </Group>

          <Group label="Effort" hint="How much reasoning to pay for.">
            {(["AUTO", "low", "medium", "high"] as const).map((e) => (
              <Choice
                key={e}
                active={settings.effort === e}
                onClick={() => update("effort", e)}
                title={e.toUpperCase()}
              />
            ))}
          </Group>

          <Group
            label="Verification"
            hint="How deeply answers are checked. Depth still rises automatically for high-risk requests."
          >
            {(["AUTO", "STANDARD", "STRICT"] as const).map((v) => (
              <Choice
                key={v}
                active={settings.verification === v}
                onClick={() => update("verification", v)}
                title={v}
              />
            ))}
          </Group>

          <Group label="Cost preference" hint="Bias the router toward price or capability.">
            {(["LOWEST", "BALANCED", "BEST_QUALITY"] as const).map((c) => (
              <Choice
                key={c}
                active={settings.costPreference === c}
                onClick={() => update("costPreference", c)}
                title={c.replace("_", " ")}
              />
            ))}
          </Group>

          <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
            <p className="text-[12px] leading-relaxed text-muted">
              These preferences affect model routing and verification depth only.
              They cannot switch off mandatory safety, privacy or policy controls,
              and they cannot bypass the Action Gate on high-risk actions.
            </p>
          </div>

          {saved && (
            <p className="flex items-center gap-1.5 text-[12px] text-ok">
              <Check className="h-3.5 w-3.5" /> Saved
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[13px] font-semibold text-ink">{label}</h2>
      {hint && <p className="mb-2.5 mt-0.5 text-[12px] text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function Choice({
  active, onClick, title, subtitle,
}: { active: boolean; onClick: () => void; title: string; subtitle?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-xl px-3.5 py-2.5 text-left transition-colors focus-ring hairline",
        active
          ? "border-accent/50 bg-accent/10 text-ink"
          : "bg-surface text-muted hover:bg-elevated hover:text-ink",
      )}
    >
      <span className="block text-[13px] font-medium">{title}</span>
      {subtitle && <span className="block text-[11px] text-muted">{subtitle}</span>}
    </button>
  );
}
