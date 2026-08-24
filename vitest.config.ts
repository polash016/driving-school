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
    include: ["src/**/*.test.{ts,tsx}", "config/**/*.test.ts"],
  },
});
