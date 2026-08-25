import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Load .env so integration tests see TEST_DATABASE_URL (Node 21+).
try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
    ".env",
  );
} catch {
  // no .env present (CI without integration DB) — unit tests still run
}

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "config/**/*.test.ts",
      "prisma/**/*.test.ts",
    ],
    env: {
      // Integration tests talk to teoripro_test, including through the `db` singleton that
      // infrastructure modules (audit log, sessions) import directly.
      ...(process.env.TEST_DATABASE_URL
        ? { DATABASE_URL: process.env.TEST_DATABASE_URL }
        : {}),
      // Mail goes to the in-memory sink; no test depends on an SMTP server being up.
      MAIL_TRANSPORT: "capture",
    },
    // Integration suites share one Postgres and one Redis — run files sequentially so they
    // cannot fight over the same rows and keys.
    fileParallelism: false,
  },
});
