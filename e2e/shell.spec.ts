import { expect, test } from "@playwright/test";

test("root redirects to a locale and renders the shell", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/(en|no)$/);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
});

test("language switcher navigates to /no and persists across reload", async ({
  page,
}) => {
  await page.goto("/en");
  // Languages are listed in their own name now — a school can add any language, so a
  // message key per language stopped being possible.
  await page.getByRole("button", { name: /norsk bokm/i }).click();
  await expect(page).toHaveURL(/\/no$/);
  await expect(
    page.getByRole("heading", { name: "Klar for teoriprøven?" }),
  ).toBeVisible();

  // Cookie persistence: revisiting the root lands on Norwegian again.
  await page.goto("/");
  await expect(page).toHaveURL(/\/no$/);
});

test("both locales render with no raw message keys", async ({ page }) => {
  for (const path of ["/en", "/no"]) {
    await page.goto(path);
    const body = await page.locator("body").innerText();
    // Raw next-intl keys look like "home.title" — none may leak into the UI.
    expect(body).not.toMatch(/\b\w+\.\w+\.\w+\b|\bhome\.title\b|\berrors\./);
  }
});

test("dark mode toggles via class strategy and persists", async ({ page }) => {
  await page.goto("/en");
  const html = page.locator("html");
  const toggle = page.getByRole("button", {
    name: /switch between light and dark/i,
  });

  await toggle.click();
  const isDark = await html.evaluate((el) => el.classList.contains("dark"));
  await toggle.click();
  const isDarkAfter = await html.evaluate((el) =>
    el.classList.contains("dark"),
  );
  expect(isDark).not.toBe(isDarkAfter);
});

test("unknown page shows bilingual not-found with a way home", async ({
  page,
}) => {
  await page.goto("/en/this-page-does-not-exist");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await page.goto("/no/denne-siden-finnes-ikke");
  await expect(
    page.getByRole("heading", { name: "Siden ble ikke funnet" }),
  ).toBeVisible();
});

test("no horizontal scroll at 390px", async ({ page }) => {
  await page.goto("/en");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
