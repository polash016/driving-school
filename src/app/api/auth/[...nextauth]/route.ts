import { handlers } from "@/server/auth";

// Auth.js session endpoints. Excluded from the next-intl proxy matcher (it skips /api),
// so these are never locale-prefixed.
export const { GET, POST } = handlers;
