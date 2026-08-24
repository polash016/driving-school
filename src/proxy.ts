import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Locale negotiation + cookie persistence for /en and /no (next-intl).
export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals, and files with extensions.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
