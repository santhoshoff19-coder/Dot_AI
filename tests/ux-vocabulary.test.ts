import { describe, expect, it } from "vitest";
import {
  defaultSpecialization, isValidSpecialization, ROLES, specializationsFor,
  categoryLabel, CATEGORIES,
} from "@/lib/library/taxonomy";
import { rankPrompts, RANKING_WEIGHTS, familiarityWeight } from "@/lib/library/service";
import {
  answerStatus, answerStatusDetail, decisionLabel, policyTypeLabel,
  appliesToLabel, ragLabel, executionLabel,
} from "@/lib/ui/labels";

function prompt(over: Partial<Parameters<typeof rankPrompts>[0][number]> = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    category: "OTHER",
    usageCount: 0,
    isFavorite: false,
    experienceLevel: null,
    specialization: null,
    ...over,
  };
}

describe("role → specialization is a real dependency", () => {
  it("gives every role its own specialization list", () => {
    const lists = ROLES.map((r) => specializationsFor(r).join("|"));
    expect(new Set(lists).size).toBe(ROLES.length);
  });

  it("does not offer engineering specializations to a teacher", () => {
    expect(specializationsFor("Teacher")).not.toContain("Software Engineering");
    expect(specializationsFor("Employee")).toContain("Software Engineering");
  });

  it("rejects a specialization that does not belong to the role", () => {
    expect(isValidSpecialization("Student", "Computer Science")).toBe(true);
    expect(isValidSpecialization("Teacher", "Computer Science")).toBe(false);
  });

  it("has a usable default for every role, and a fallback for unknown ones", () => {
    for (const role of ROLES) {
      expect(specializationsFor(role)).toContain(defaultSpecialization(role));
    }
    expect(defaultSpecialization("Marine Biologist")).toBe("Other");
    expect(specializationsFor("Marine Biologist")).toEqual([]);
  });

  it("labels every category without leaking a raw enum", () => {
    for (const c of CATEGORIES) {
      const label = categoryLabel(c);
      expect(label).toBeTruthy();
      // A screaming-snake value reaching the UI means the map has a hole.
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
    expect(categoryLabel("ANALYSIS")).toBe("Data/Analysis");
  });
});

describe("library ranking is deterministic and explainable", () => {
  it("weights sum to one, so a score reads as a proportion", () => {
    const total = Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("ranks a matching category above an unrelated one", () => {
    const ranked = rankPrompts(
      [prompt({ category: "OTHER" }), prompt({ category: "CODING" })],
      { role: "Employee", specialization: "Software Engineering", experience: "Advanced" },
    );
    expect(ranked[0].prompt.category).toBe("CODING");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("changes the order when the profile changes", () => {
    const prompts = [prompt({ category: "CODING" }), prompt({ category: "MARKETING" })];

    const engineer = rankPrompts(prompts, {
      role: "Employee", specialization: "Software Engineering", experience: "Advanced",
    });
    const marketer = rankPrompts(prompts, {
      role: "Employee", specialization: "Marketing", experience: "Advanced",
    });

    expect(engineer[0].prompt.category).toBe("CODING");
    expect(marketer[0].prompt.category).toBe("MARKETING");
  });

  it("explains a recommendation using the signals that actually fired", () => {
    // ANALYSIS sits in both the Employee role list and the Software
    // Engineering specialization list, so both signals should be named.
    const ranked = rankPrompts(
      [prompt({ category: "ANALYSIS", isFavorite: true })],
      { role: "Employee", specialization: "Software Engineering", experience: "Advanced" },
    );
    expect(ranked[0].why).toContain("Employee");
    expect(ranked[0].why).toContain("Software Engineering");
  });

  it("says so plainly when nothing matched, rather than inventing a reason", () => {
    const ranked = rankPrompts(
      [prompt({ category: "OTHER" })],
      { role: "Marine Biologist", specialization: "Cephalopods", experience: "Expert" },
    );
    expect(ranked[0].why).toContain("does not match your profile");
  });

  it("lets experience change how much popularity counts", () => {
    expect(familiarityWeight("Beginner")).toBeGreaterThan(familiarityWeight("Expert"));

    const prompts = [
      prompt({ category: "OTHER", usageCount: 10 }),
      prompt({ category: "CODING", usageCount: 0 }),
    ];
    const beginner = rankPrompts(prompts, {
      role: "Employee", specialization: "Software Engineering", experience: "Beginner",
    });
    const expert = rankPrompts(prompts, {
      role: "Employee", specialization: "Software Engineering", experience: "Expert",
    });

    // The popular-but-unrelated prompt is scored more generously for a
    // beginner than for an expert.
    const popularBeginner = beginner.find((r) => r.prompt.usageCount === 10)!.score;
    const popularExpert = expert.find((r) => r.prompt.usageCount === 10)!.score;
    expect(popularBeginner).toBeGreaterThan(popularExpert);
  });
});

describe("answer status never overstates what was checked", () => {
  it("only says Verified when claims were actually checked", () => {
    expect(answerStatus({
      decision: "ALLOW", verificationStatus: "SUPPORTED", claimsChecked: 2,
    })).toBe("VERIFIED");
  });

  it("calls an allowed answer with nothing checked Unverified, not Verified", () => {
    expect(answerStatus({
      decision: "ALLOW", verificationStatus: "SUPPORTED", claimsChecked: 0,
    })).toBe("UNVERIFIED");
    expect(answerStatus({
      decision: "ALLOW", verificationStatus: "UNVERIFIABLE", claimsChecked: 0,
    })).toBe("UNVERIFIED");
  });

  it("surfaces a contradiction as needing review even when allowed", () => {
    expect(answerStatus({
      decision: "ALLOW", verificationStatus: "CONTRADICTED", claimsChecked: 1,
    })).toBe("REVIEW");
  });

  it("maps hold and block to their own states", () => {
    expect(answerStatus({
      decision: "HOLD", verificationStatus: "SUPPORTED", claimsChecked: 3,
    })).toBe("REVIEW");
    expect(answerStatus({
      decision: "BLOCK", verificationStatus: "SUPPORTED", claimsChecked: 3,
    })).toBe("BLOCKED");
  });

  it("explains each state in the reader's terms", () => {
    expect(answerStatusDetail("VERIFIED", 1)).toContain("1 claim checked");
    expect(answerStatusDetail("VERIFIED", 3)).toContain("3 claims checked");
    expect(answerStatusDetail("UNVERIFIED", 0)).toContain("Nothing in this response");
    expect(answerStatusDetail("BLOCKED", 0)).toContain("not delivered");
  });
});

describe("shared vocabulary is used consistently", () => {
  it("renames policy identifiers for display without changing them", () => {
    expect(policyTypeLabel("INTERNAL")).toBe("Company Policy");
    expect(policyTypeLabel("GDPR")).toBe("Privacy / Data Protection");
    expect(policyTypeLabel("DPDP")).toBe("Privacy / Data Protection");
    expect(policyTypeLabel("SOX")).toBe("Financial Compliance");
    expect(appliesToLabel("EU")).toBe("European Union");
    expect(appliesToLabel("IN")).toBe("India");
  });

  it("falls back to the raw value for anything unmapped", () => {
    expect(policyTypeLabel("CCPA")).toBe("CCPA");
    expect(appliesToLabel("BR")).toBe("BR");
    expect(executionLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("describes retrieval in four words or fewer", () => {
    expect(ragLabel(undefined)).toBe("RAG not used");
    expect(ragLabel({
      mode: "OFF", label: "OFF", triggered: false, retrievalType: "NONE",
    })).toBe("RAG off");
    expect(ragLabel({
      mode: "AUTO", label: "NOT USED", triggered: false, retrievalType: "NONE",
    })).toBe("RAG not used");
    expect(ragLabel({
      mode: "AUTO", label: "USED — POLICY", triggered: true, retrievalType: "POLICY",
    })).toBe("RAG used · Policy");
    expect(ragLabel({
      mode: "ON", label: "FORCED ON", triggered: true, retrievalType: "BOTH",
    })).toBe("RAG forced · Evidence + Policy");
  });

  it("gives every decision a plain-language name", () => {
    expect(decisionLabel("ALLOW")).toBe("Verified");
    expect(decisionLabel("HOLD")).toBe("Needs review");
    expect(decisionLabel("BLOCK")).toBe("Blocked");
  });
});
