import { modelCatalogSyncService } from "@/lib/models/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manual catalog synchronisation. Never required on a user request path. */
export async function POST() {
  const result = await modelCatalogSyncService.sync();
  // A failed sync is reported, not thrown: routing continues on the existing
  // catalog regardless.
  return Response.json(result, { status: result.status === "FAILED" ? 502 : 200 });
}

export async function GET() {
  const last = await modelCatalogSyncService.lastSync();
  return Response.json({ lastSync: last });
}
