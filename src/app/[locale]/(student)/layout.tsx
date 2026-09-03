import { requireUser } from "@/server/auth/require-user";

/**
 * Auth gate for the student panel.
 *
 * It lives in a LAYOUT rather than only in each page because a route with a `loading.tsx` streams:
 * the response headers flush as 200 before the page body runs, so an `unauthorized()` thrown
 * inside the page can no longer set a 401. A layout renders outside that Suspense boundary, so the
 * status code is still real — which is what spec-12 and the auth-coverage test require.
 *
 * Pages keep their own `requireUser()` call: it is what they get their `SessionUser` from, and a
 * page that is ever moved out of this group must not silently lose its guard.
 */
export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();
  return <>{children}</>;
}
