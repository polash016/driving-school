import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/require-user";
import { storage } from "@/server/storage";
import { logger } from "@/lib/logger";

/**
 * The ONLY way question-image bytes reach a browser (spec-06 amendment D3).
 *
 * Storage is deliberately not public — no `public/` directory, no world-readable bucket — so that
 * this route is the single chokepoint where access is decided. Two things depend on that:
 *
 *   - Exam images must not be scrapeable by anyone who guesses a URL, which is what a static path
 *     would allow. `requireUser()` runs before a byte is read.
 *   - Spec-12 adds signed short-TTL URLs and per-student watermarking. Both are changes to THIS
 *     file only, which is only true while it stays the sole entry point.
 *
 * `Cache-Control: private` keeps a shared proxy from holding a copy; `no-store` would defeat the
 * image cache on the exam screen, where re-fetching on every question is exactly the stutter the
 * smoothness mandate forbids.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Throws the framework's 401/403 interrupts (authInterrupts), so an unauthenticated fetch gets a
  // real status rather than a redirect to HTML that an <img> tag would silently render as broken.
  await requireUser();

  const { id } = await params;
  const image = await db.imageAsset.findFirst({
    where: { id, deletedAt: null },
    select: { storagePath: true },
  });
  if (!image) return new NextResponse(null, { status: 404 });

  try {
    const { body, contentType, contentLength } = await storage().stream(
      image.storagePath,
    );
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(contentLength),
        "Cache-Control": "private, max-age=300",
        // The bytes are an image and nothing else; stop a browser from ever sniffing them into
        // something executable.
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    // A row whose bytes are gone is an operational problem, not something to explain to a student.
    logger.error(
      {
        imageId: id,
        storagePath: image.storagePath,
        error: String(error).slice(0, 300),
      },
      "image bytes missing from storage",
    );
    return new NextResponse(null, { status: 404 });
  }
}
