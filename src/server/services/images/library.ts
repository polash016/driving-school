import type { PrismaClient } from "@prisma/client";

/**
 * Everything a question can be asked about, in one list for the editor's picker.
 *
 * Two sources, deliberately one list: photographs uploaded in /admin/images, and the sign registry
 * wrapped in ImageAsset rows by `pnpm signs:questions`. From the engine's side they are the same
 * thing — `MasterItem.sourceImageId` — and an author choosing a picture should not have to know
 * which table it came from.
 *
 * The two differ in how their bytes are served, which is why `kind` is returned: an upload is
 * private and streams through `/api/images/[id]` behind a session, while a sign graphic is public
 * reference material served straight from `public/signs/` (spec-10 puts it in a browsable
 * catalogue and a logged-out demo quiz).
 */
export type PickableImage = {
  id: string;
  url: string;
  label: string;
  kind: "UPLOAD" | "SIGN";
};

/** Enough to fill a picker without paginating it; the registry is ~300 and uploads start at zero. */
const LIMIT = 400;

export async function listPickableImages(
  db: PrismaClient,
): Promise<PickableImage[]> {
  const assets = await db.imageAsset.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      url: true,
      storagePath: true,
      createdAt: true,
      licenseAttestation: true,
    },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
  });

  // Sign codes are the only human-readable label a registry asset has; uploads fall back to a
  // short id, which is at least stable and distinguishable in a grid of thumbnails.
  const signCodes = new Map(
    (
      await db.sign.findMany({
        select: { code: true, svgPath: true, name: true },
      })
    ).map((sign) => [sign.svgPath, sign]),
  );

  return assets.map((asset) => {
    const sign = signCodes.get(asset.url);
    if (sign) {
      const name = sign.name as { en?: string } | null;
      return {
        id: asset.id,
        url: asset.url,
        label: name?.en ? `${sign.code} · ${name.en}` : sign.code,
        kind: "SIGN" as const,
      };
    }
    return {
      id: asset.id,
      url: asset.url,
      label: asset.id.slice(-6),
      kind: "UPLOAD" as const,
    };
  });
}
