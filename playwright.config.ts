import { defineConfig, devices } from "@playwright/test";

// Load .env so specs can seed Postgres directly and reach the dev mail sink (spec-03).
try {
  (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(".env");
} catch {
  // no .env — specs that need the database will fail loudly rather than silently skip
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    // Student panel is mobile-first at 390px — e2e runs on a phone viewport.
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start --port 3100",
    url: "http://localhost:3100/en",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
