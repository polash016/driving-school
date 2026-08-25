import { headers } from "next/headers";

/**
 * Per-request client identity for rate limiting and audit rows (spec-03).
 * Lives in the Next layer: services receive these values as plain data.
 */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export async function requestContext(): Promise<RequestContext> {
  const headerList = await headers();
  // The first entry of x-forwarded-for is the client; the proxy chain follows.
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: forwarded || headerList.get("x-real-ip") || null,
    userAgent: headerList.get("user-agent"),
  };
}
