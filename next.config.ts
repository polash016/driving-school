import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  typedRoutes: true,
  // argon2 ships a native .node binary — keep it out of the bundle (spec-03).
  serverExternalPackages: ["@node-rs/argon2"],
  experimental: {
    // Enables forbidden()/unauthorized() + their boundaries, so wrong-role access returns a
    // real 403 and unauthenticated access a real 401 (spec-03 acceptance checklist).
    authInterrupts: true,
  },
};

export default withNextIntl(nextConfig);
