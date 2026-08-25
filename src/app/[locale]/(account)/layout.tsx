import { requireUser } from "@/server/auth/require-user";

/**
 * Every route in this group needs a signed-in user. Enforcement is server-side and per
 * request — never in the proxy alone (architecture §7.2).
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();
  return children;
}
