import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// WCAG 2.1 AA is Norwegian law (universell utforming) — no serious/critical
// violations allowed on the shell, in either locale or theme.
for (const path of [
  "/en",
  "/no",
  "/en/login",
  "/no/login",
  "/en/forgot-password",
  "/no/forgot-password",
]) {
  test(`axe: no serious/critical violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    expect(
      blocking.map((v) => `${v.id}: ${v.description}`),
    ).toEqual([]);
  });
}

test("axe: dark mode shell has no serious/critical violations", async ({
  page,
}) => {
  await page.goto("/en");
  await page
    .getByRole("button", { name: /switch between light and dark/i })
    .click();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(blocking.map((v) => `${v.id}: ${v.description}`)).toEqual([]);
});
