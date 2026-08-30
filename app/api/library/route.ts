import { NextRequest } from "next/server";
import { currentUserId } from "@/lib/auth/identity";
import { CATEGORIES, library } from "@/lib/library/service";
import { parseTemplate, VARIABLE_TYPES } from "@/lib/library/variables";
import { handleError } from "@/lib/library/http";
import { seedLibraryPrompts } from "@/lib/library/seed-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const userId = await currentUserId();

    // A new library is empty, which tells the user nothing about what the
    // feature is for. Seeding runs once and never overwrites: a prompt the
    // user already has, or has edited, is left alone.
    await seedLibraryPrompts(userId);

    const url = new URL(req.url);
    const filter = (url.searchParams.get("filter") ?? "ALL") as "ALL" | "FAVORITES" | "RECENT";

    const [prompts, favorites, profile, recommended] = await Promise.all([
      library.list(userId, {
        search: url.searchParams.get("q") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        filter,
      }),
      library.favoriteIds(userId),
      library.getProfile(userId),
      library.recommended(userId),
    ]);

    return Response.json({
      prompts: prompts.map((p) => ({ ...p, isFavorite: favorites.includes(p.id) })),
      recommended: recommended.map((p) => ({ ...p, isFavorite: favorites.includes(p.id) })),
      favorites,
      profile,
      categories: CATEGORIES,
      variableTypes: VARIABLE_TYPES,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await currentUserId();
    const body = await req.json();
    const created = await library.create(userId, body);
    return Response.json(created, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

/** Parses a template without saving, so the editor can preview its fields. */
export async function PUT(req: NextRequest) {
  try {
    const { template } = (await req.json()) as { template?: string };
    return Response.json(parseTemplate(template ?? ""));
  } catch (err) {
    return handleError(err);
  }
}
