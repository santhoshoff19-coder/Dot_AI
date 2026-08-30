import { prisma } from "@/lib/db";
import {
  fillTemplate, humanLabel, inferType, parseTemplate, sanitiseValue,
  VARIABLE_TYPES, type VariableSpec, type VariableType,
} from "@/lib/library/variables";

import {
  CATEGORIES, defaultSpecialization, isValidSpecialization,
  ROLE_CATEGORIES, SPECIALIZATION_CATEGORIES, type Category,
} from "@/lib/library/taxonomy";

export { CATEGORIES };
export type { Category };

export const MODALITIES = ["TEXT", "IMAGE", "DOCUMENT"] as const;

export interface VariableInput {
  name: string;
  label?: string;
  description?: string;
  type?: VariableType;
  required?: boolean;
  defaultValue?: string;
  options?: string[];
}

export interface PromptInput {
  title: string;
  description?: string;
  category?: string;
  template: string;
  inputModality?: string;
  outputModality?: string;
  taskType?: string;
  variables?: VariableInput[];
}

export class OwnershipError extends Error {
  readonly status = 404;
  constructor() {
    // Deliberately indistinguishable from "does not exist": confirming that
    // another user's prompt exists is itself a small leak.
    super("Prompt not found.");
    this.name = "OwnershipError";
  }
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Prompt Library.
 *
 * Every read and write is scoped to an owner. Deletion is soft, so usage and
 * audit history survive; edits bump a version so a historical run stays
 * attributable to the template text that actually ran.
 */
export class LibraryService {
  /**
   * Reconciles declared variables against the template. The template is the
   * source of truth: a variable the author removed from the text disappears,
   * and one they added appears with sensible defaults.
   */
  private reconcileVariables(
    template: string, declared: VariableInput[] = [],
  ): (VariableSpec & { label: string; description: string; order: number })[] {
    const parsed = parseTemplate(template);
    if (!parsed.valid) {
      throw new ValidationError("The template has invalid placeholders.", parsed.issues);
    }

    const byName = new Map(declared.map((d) => [d.name.toUpperCase(), d]));

    return parsed.variables.map((v) => {
      const d = byName.get(v.name);
      const type: VariableType = d?.type && VARIABLE_TYPES.includes(d.type)
        ? d.type : inferType(v.name);
      const options = (d?.options ?? []).map((o) => String(o).slice(0, 120)).slice(0, 30);

      if (type === "SELECT" && options.length === 0) {
        throw new ValidationError(`Variable ${v.name} is a SELECT but has no options.`);
      }

      return {
        name: v.name,
        label: (d?.label ?? "").trim() || humanLabel(v.name),
        description: (d?.description ?? "").slice(0, 300),
        type,
        required: d?.required ?? true,
        defaultValue: (d?.defaultValue ?? "").slice(0, 2000),
        options,
        order: v.order,
      };
    });
  }

  private validate(input: PromptInput): void {
    if (!input.title?.trim()) throw new ValidationError("A title is required.");
    if (input.title.length > 160) throw new ValidationError("Title is too long.");
    if (!input.template?.trim()) throw new ValidationError("A template is required.");
    if (input.category && !CATEGORIES.includes(input.category as Category)) {
      throw new ValidationError(`Unknown category '${input.category}'.`);
    }
    for (const key of ["inputModality", "outputModality"] as const) {
      const v = input[key];
      if (v && !MODALITIES.includes(v as (typeof MODALITIES)[number])) {
        throw new ValidationError(`Unknown ${key} '${v}'.`);
      }
    }
  }

  async create(ownerId: string, input: PromptInput) {
    this.validate(input);
    const variables = this.reconcileVariables(input.template, input.variables);

    return prisma.promptTemplate.create({
      data: {
        ownerId,
        title: input.title.trim(),
        description: (input.description ?? "").slice(0, 600),
        category: (input.category as Category) ?? "OTHER",
        template: input.template,
        inputModality: input.inputModality ?? "TEXT",
        outputModality: input.outputModality ?? "TEXT",
        taskType: input.taskType ?? "AUTO",
        variables: {
          create: variables.map((v) => ({
            name: v.name, label: v.label, description: v.description,
            type: v.type, required: v.required, defaultValue: v.defaultValue,
            options: JSON.stringify(v.options), order: v.order,
          })),
        },
      },
      include: { variables: { orderBy: { order: "asc" } } },
    });
  }

  /** Ownership is enforced here, not at the route, so it cannot be forgotten. */
  async get(ownerId: string, id: string) {
    const prompt = await prisma.promptTemplate.findFirst({
      where: { id, ownerId, deletedAt: null },
      include: { variables: { orderBy: { order: "asc" } } },
    });
    if (!prompt) throw new OwnershipError();
    return prompt;
  }

  async list(ownerId: string, opts: {
    search?: string; category?: string; filter?: "ALL" | "FAVORITES" | "RECENT";
    limit?: number;
  } = {}) {
    const limit = Math.min(opts.limit ?? 100, 200);

    if (opts.filter === "RECENT") {
      const usages = await prisma.promptUsage.findMany({
        where: { userId: ownerId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { promptId: true },
      });
      const ids = [...new Set(usages.map((u) => u.promptId))];
      if (ids.length === 0) return [];
      const rows = await prisma.promptTemplate.findMany({
        where: { id: { in: ids }, ownerId, deletedAt: null },
        include: { variables: { orderBy: { order: "asc" } } },
      });
      // Preserve recency order from the usage query.
      return ids
        .map((id) => rows.find((r) => r.id === id))
        .filter((r): r is (typeof rows)[number] => Boolean(r));
    }

    const favouriteIds = opts.filter === "FAVORITES"
      ? (await prisma.promptFavorite.findMany({
          where: { userId: ownerId }, select: { promptId: true },
        })).map((f) => f.promptId)
      : null;

    if (favouriteIds && favouriteIds.length === 0) return [];

    const search = opts.search?.trim();

    return prisma.promptTemplate.findMany({
      where: {
        ownerId,
        deletedAt: null,
        ...(favouriteIds ? { id: { in: favouriteIds } } : {}),
        ...(opts.category && opts.category !== "ALL" ? { category: opts.category } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search } },
                { description: { contains: search } },
                { category: { contains: search } },
                { template: { contains: search } },
              ],
            }
          : {}),
      },
      include: { variables: { orderBy: { order: "asc" } } },
      orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
      take: limit,
    });
  }

  /**
   * Updates a prompt and bumps its version. Variables are replaced to match
   * the new template; usage history is untouched.
   */
  async update(ownerId: string, id: string, input: Partial<PromptInput>) {
    const existing = await this.get(ownerId, id);
    const template = input.template ?? existing.template;

    const merged: PromptInput = {
      title: input.title ?? existing.title,
      description: input.description ?? existing.description,
      category: input.category ?? existing.category,
      template,
      inputModality: input.inputModality ?? existing.inputModality,
      outputModality: input.outputModality ?? existing.outputModality,
      taskType: input.taskType ?? existing.taskType,
      variables: input.variables,
    };
    this.validate(merged);

    const variables = this.reconcileVariables(
      template,
      input.variables ?? existing.variables.map((v) => ({
        name: v.name, label: v.label, description: v.description,
        type: v.type as VariableType, required: v.required,
        defaultValue: v.defaultValue, options: safeOptions(v.options),
      })),
    );

    await prisma.promptVariable.deleteMany({ where: { promptId: id } });

    return prisma.promptTemplate.update({
      where: { id },
      data: {
        title: merged.title!.trim(),
        description: merged.description ?? "",
        category: merged.category ?? "OTHER",
        template,
        inputModality: merged.inputModality ?? "TEXT",
        outputModality: merged.outputModality ?? "TEXT",
        taskType: merged.taskType ?? "AUTO",
        version: { increment: 1 },
        variables: {
          create: variables.map((v) => ({
            name: v.name, label: v.label, description: v.description,
            type: v.type, required: v.required, defaultValue: v.defaultValue,
            options: JSON.stringify(v.options), order: v.order,
          })),
        },
      },
      include: { variables: { orderBy: { order: "asc" } } },
    });
  }

  /** Soft delete. Usage, audit and ControlPlane records are left intact. */
  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await prisma.promptTemplate.update({
      where: { id }, data: { deletedAt: new Date() },
    });
    return { deleted: true };
  }

  async toggleFavorite(ownerId: string, id: string) {
    await this.get(ownerId, id);
    const existing = await prisma.promptFavorite.findUnique({
      where: { promptId_userId: { promptId: id, userId: ownerId } },
    });
    if (existing) {
      await prisma.promptFavorite.delete({ where: { id: existing.id } });
      return { favorited: false };
    }
    await prisma.promptFavorite.create({ data: { promptId: id, userId: ownerId } });
    return { favorited: true };
  }

  async favoriteIds(ownerId: string): Promise<string[]> {
    const rows = await prisma.promptFavorite.findMany({
      where: { userId: ownerId }, select: { promptId: true },
    });
    return rows.map((r) => r.promptId);
  }

  /**
   * Resolves a prompt into the text that will enter the pipeline. Values are
   * sanitised, and a missing required variable stops the run rather than
   * sending a literal placeholder to a model.
   */
  async prepare(ownerId: string, id: string, values: Record<string, string>) {
    const prompt = await this.get(ownerId, id);

    const specs: VariableSpec[] = prompt.variables.map((v) => ({
      name: v.name,
      type: v.type as VariableType,
      required: v.required,
      defaultValue: v.defaultValue,
      options: safeOptions(v.options),
    }));

    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      clean[k.toUpperCase()] = sanitiseValue(String(v ?? ""));
    }

    const filled = fillTemplate(prompt.template, clean, specs);
    if (!filled.ok) {
      throw new ValidationError("The prompt is missing required values.", {
        missing: filled.missing, invalid: filled.invalid,
      });
    }

    return {
      prompt,
      filledPrompt: filled.prompt,
      outputModality: prompt.outputModality,
      inputModality: prompt.inputModality,
    };
  }

  /** Records an execution. The template snapshot preserves what actually ran. */
  async recordUsage(ownerId: string, id: string, run: {
    filledPrompt: string; conversationId?: string | null;
    requestId?: string | null; selectedModel?: string; success: boolean;
  }) {
    const prompt = await this.get(ownerId, id);

    await prisma.$transaction([
      prisma.promptUsage.create({
        data: {
          promptId: id,
          userId: ownerId,
          conversationId: run.conversationId ?? null,
          requestId: run.requestId ?? null,
          selectedModel: run.selectedModel ?? "",
          promptVersion: prompt.version,
          templateSnapshot: prompt.template,
          filledPrompt: run.filledPrompt.slice(0, 4000),
          success: run.success,
        },
      }),
      prisma.promptTemplate.update({
        where: { id }, data: { usageCount: { increment: 1 } },
      }),
    ]);
  }

  async usageFor(ownerId: string, id: string) {
    await this.get(ownerId, id);
    return prisma.promptUsage.findMany({
      where: { promptId: id, userId: ownerId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  // --- profile ------------------------------------------------------------

  async getProfile(userId: string) {
    return prisma.userProfile.findUnique({ where: { userId } });
  }

  async saveProfile(userId: string, input: {
    designation?: string; specialization?: string;
    experience?: string; customRole?: string;
  }) {
    const designation = (input.designation ?? "Student").slice(0, 60);
    const requested = (input.specialization ?? "").slice(0, 60);

    // A specialization that does not belong to the role is dropped rather
    // than stored. Keeping "SDE" on a Teacher would quietly skew every
    // recommendation afterwards, with nothing on screen to explain it.
    const specialization = isValidSpecialization(designation, requested)
      ? requested
      : defaultSpecialization(designation);

    const data = {
      designation,
      specialization,
      experience: (input.experience ?? "Intermediate").slice(0, 40),
      customRole: input.customRole?.slice(0, 120) ?? null,
    };
    return prisma.userProfile.upsert({
      where: { userId }, create: { userId, ...data }, update: data,
    });
  }

  /**
   * Orders the user's prompts by fit with their profile.
   *
   * Personalization only reorders; it never hides a prompt and never rewrites
   * what the user asked for.
   */
  async recommended(userId: string, limit = 12) {
    const [profile, prompts] = await Promise.all([
      this.getProfile(userId),
      this.list(userId, { limit: 200 }),
    ]);
    if (!profile) return prompts.slice(0, limit);

    const ranked = rankPrompts(prompts, {
      role: profile.designation,
      specialization: profile.specialization,
      experience: profile.experience,
    });

    return ranked.slice(0, limit).map((r) => ({ ...r.prompt, whyRecommended: r.why }));
  }
}

/**
 * Deterministic V1 ranking weights. Fixed, inspectable, and summing to 1 so a
 * score is readable as a percentage. This is ranking arithmetic, not a
 * recommender system, and it is deliberately kept that way.
 */
export const RANKING_WEIGHTS = {
  role: 0.35,
  specialization: 0.25,
  experience: 0.15,
  category: 0.10,
  recentUse: 0.10,
  favorite: 0.05,
} as const;

export interface RankableProfile {
  role: string;
  specialization: string;
  experience: string;
}

export interface RankedPrompt<T> {
  prompt: T;
  score: number;
  /** One sentence naming the signals that actually fired. */
  why: string;
}

/**
 * Ranks prompts against a profile and explains each result.
 *
 * Every contribution is recorded as it is added, so the explanation is
 * generated from the same arithmetic that produced the order. A reason
 * written separately from the score would eventually disagree with it.
 */
export function rankPrompts<
  T extends {
    category: string; usageCount: number; isFavorite?: boolean;
    experienceLevel?: string | null; specialization?: string | null;
  },
>(prompts: T[], profile: RankableProfile): RankedPrompt<T>[] {
  const roleCats = ROLE_CATEGORIES[profile.role] ?? [];
  const specCats = SPECIALIZATION_CATEGORIES[profile.specialization] ?? [];
  const familiarity = familiarityWeight(profile.experience);
  const maxUse = Math.max(1, ...prompts.map((p) => p.usageCount));

  return [...prompts]
    .map((p) => {
      let score = 0;
      const reasons: string[] = [];

      // Role: does this category suit what they do?
      const roleRank = roleCats.indexOf(p.category as Category);
      if (roleRank >= 0) {
        score += RANKING_WEIGHTS.role * (1 - roleRank / Math.max(roleCats.length, 1));
        reasons.push(profile.role);
      }

      // Specialization: a sharper version of the same question.
      const specRank = specCats.indexOf(p.category as Category);
      if (specRank >= 0) {
        score += RANKING_WEIGHTS.specialization * (1 - specRank / Math.max(specCats.length, 1));
        reasons.push(profile.specialization);
      }

      // Experience: an explicitly levelled prompt matching the user's level.
      if (p.experienceLevel && p.experienceLevel === profile.experience) {
        score += RANKING_WEIGHTS.experience;
        reasons.push(profile.experience);
      }

      // Category presence at all, so an unmatched prompt is not scored zero
      // purely for existing.
      if (p.category && p.category !== "OTHER") score += RANKING_WEIGHTS.category * 0.5;

      // Recent use, weighted by how much this user should be steered by
      // popularity: a beginner benefits from what already works, an expert
      // usually wants their own specialised prompts.
      const use = (p.usageCount / maxUse) * familiarity;
      if (p.usageCount > 0) {
        score += RANKING_WEIGHTS.recentUse * Math.min(use, 1);
        reasons.push("used before");
      }

      if (p.isFavorite) {
        score += RANKING_WEIGHTS.favorite;
        reasons.push("favorite");
      }

      return {
        prompt: p,
        score: Math.round(score * 1e4) / 1e4,
        why: reasons.length
          ? `Recommended because it matches ${reasons.slice(0, 3).join(" + ")}.`
          : "Shown because your library is small; it does not match your profile yet.",
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * How heavily a prompt's usage history counts, by stated experience.
 *
 * This is the only thing `experience` does, and it is deliberately modest:
 * ordering shifts, nothing is hidden, and no prompt becomes unavailable.
 */
export function familiarityWeight(experience: string): number {
  return ({
    Beginner: 1.5,
    Intermediate: 1,
    Advanced: 0.6,
    Expert: 0.4,
  } as Record<string, number>)[experience] ?? 1;
}

/**
 * Category affinity for a role and specialization, most relevant first.
 *
 * Delegates to the taxonomy so there is exactly one place where "what does
 * this person work on" is defined. Kept as a function because callers want
 * the merged, de-duplicated order rather than the two raw lists.
 */
export function preferredCategories(
  designation: string, specialization: string,
): string[] {
  return [
    ...(SPECIALIZATION_CATEGORIES[specialization] ?? []),
    ...(ROLE_CATEGORIES[designation] ?? []),
    "OTHER",
  ].filter((c, i, a) => a.indexOf(c) === i);
}

function safeOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const library = new LibraryService();
