import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routingFor } from "./i18n/runtime-routing";
import { getRegistry } from "./server/services/i18n/registry";

/**
 * Locale negotiation and cookie persistence, over the languages that exist right now (spec-15).
 *
 * The middleware is constructed per request from the language registry, so adding a language in
 * the admin panel makes its URLs routable immediately — no redeploy, no restart.
 *
 * Deliberately NOT reading Postgres here. `src/server/db.ts` only pins its client to `globalThis`
 * outside production, so importing it into the middleware bundle would open a second connection
 * pool. The registry falls back memo → Redis → the compiled `en`/`nb` list, and the app side
 * repopulates Redis on a miss. A cold proxy therefore routes the two original languages correctly
 * and picks up the rest within the memo's TTL.
 */
export default async function proxy(request: NextRequest) {
  const registry = await getRegistry();
  // The locale layout sends a student away from an unpublished language to the same page under
  // the fallback (spec-20), and a layout has no other way to learn its path. next-intl forwards
  // the request headers it is handed, so this rides along with `x-next-intl-locale`.
  const headers = new Headers(request.headers);
  headers.set("x-pathname", request.nextUrl.pathname);
  return createMiddleware(routingFor(registry))(
    new NextRequest(request, { headers }),
  );
}

export const config = {
  // Skip API routes, Next internals, and files with extensions.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
