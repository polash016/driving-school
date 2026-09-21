import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The no-gap guarantee, end to end (spec-22).
 *
 * This is the test the whole design exists for. Two properties must hold at EVERY point of a
 * rewrite, with no window in between:
 *
 *   1. A student in a translated language never reads a STALE translation over new English.
 *   2. A student in a translated language never falls back to English either.
 *
 * Property 1 is the dangerous one. `loadOverlay` selects a translation by status alone and never
 * compares `sourceHash`; `loadQuestionOverlay` only checks that the variant's `masterVersion`
 * matches the master's — which an in-place rewrite satisfies, because it bumps both. And
 * `mergeQuestion` merges by option KEY, which a faithful rewrite preserves byte for byte. So every
 * guard in the serving path passes while the text underneath has changed.
 *
 * The test therefore asserts on what `loadQuestionOverlay` + `mergeQuestion` actually return — the
 * real serving path — rather than on what the tables contain.
 */

const aiEmbed = vi.fn(async (texts: string[]) =>
  // Deterministic, mutually distant vectors: nothing must trip the distinctness or leak checks.
  texts.map((text, index) => {
    const v = new Array(8).fill(0);
    v[index % 8] = 1;
    v[(text.length * 7) % 8] += 0.01;
    return v;
  }),
);
vi.mock("@/server/ai/client", () => ({
  aiJson: vi.fn(),
  aiEmbed: (...args: unknown[]) => aiEmbed(...(args as [string[]])),
}));

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { upsertItem } = await import("./items");
const { transitionItem } = await import("./transitions");
const { contentFingerprint, rewriteApprovedItemInPlace, rollbackRewrite } = await import("./rewrite");
const { loadQuestionOverlay, mergeQuestion } = await import("@/server/services/i18n/resolve");

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = describe.skipIf(!enabled);

const RUN = randomUUID().slice(0, 8);
const LOCALE = `zn${RUN.slice(0, 2)}`;
const author = { id: "", role: "ADMIN" as const, email: `ng-${RUN}@example.no` };
const reviewer = { id: "", role: "ADMIN" as const, email: `ng-r-${RUN}@example.no` };

let topicId = "";
let licenseClassId = "";
let itemId = "";

const OLD_EN = {
  stem: "You are approaching an unmarked junction on a road with a 50 km/h limit. Who must give way?",
  options: [
    { key: "a", text: "You must give way to traffic coming from your right" },
    { key: "b", text: "Traffic from your right must give way to you" },
    { key: "c", text: "Whoever reaches the junction first has priority" },
  ],
  explanation: "The rule of the right applies at an unmarked junction. See § 7.",
};
const NEW_EN = {
  stem: "Unmarked junction, 50 km/h. Who gives way?",
  options: [
    { key: "a", text: "You give way to the right" },
    { key: "b", text: "The right gives way to you" },
    { key: "c", text: "First to arrive has priority" },
  ],
  explanation: "Rule of the right applies. See § 7.",
};
const nb = (side: typeof OLD_EN) => ({
  stem: `NB ${side.stem}`,
  options: side.options.map((o) => ({ key: o.key, text: `NB ${o.text}` })),
  explanation: `NB ${side.explanation}`,
});

/** The stale translation: correct for OLD_EN, wrong for NEW_EN, same keys. */
const STALE = {
  stem: "XX long stale stem",
  options: [
    { key: "a", text: "XX stale option A" },
    { key: "b", text: "XX stale option B" },
    { key: "c", text: "XX stale option C" },
  ],
  explanation: "XX stale explanation",
};
const FRESH = {
  stem: "YY short fresh stem",
  options: [
    { key: "a", text: "YY fresh A" },
    { key: "b", text: "YY fresh B" },
    { key: "c", text: "YY fresh C" },
  ],
  explanation: "YY fresh explanation",
};

async function servedText(): Promise<{ stem: string; options: string[] }> {
  const variant = await db.itemVariant.findFirstOrThrow({
    where: { masterItemId: itemId, isActive: true },
    select: { id: true, masterItemId: true, masterVersion: true, source: true, content: true },
  });
  const master = await db.masterItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { version: true },
  });
  const overlay = await loadQuestionOverlay(db, LOCALE, [
    {
      variantId: variant.id,
      masterItemId: variant.masterItemId,
      masterVersion: variant.masterVersion,
      source: variant.source,
      currentMasterVersion: master.version,
    },
  ]);
  const source = (variant.content as { en: typeof OLD_EN }).en;
  const merged = mergeQuestion(source, overlay.get(variant.id));
  return { stem: merged.stem, options: merged.options.map((o) => o.text) };
}

beforeAll(async () => {
  for (const user of [author, reviewer]) {
    const row = await db.user.create({
      data: { email: user.email, role: "ADMIN" },
      select: { id: true },
    });
    user.id = row.id;
  }
  const topic = await db.topic.create({
    data: { slug: `ng-${RUN}`, name: { en: "NoGap", nb: "NoGap" }, sortOrder: 901 },
    select: { id: true },
  });
  topicId = topic.id;
  licenseClassId = (await db.licenseClass.findFirstOrThrow({ select: { id: true } })).id;

  // A language that SERVES machine translations — the published case (bn and es in production).
  await db.language.upsert({
    where: { code: LOCALE },
    create: {
      code: LOCALE,
      urlPrefix: LOCALE,
      englishName: "NoGap Probe",
      nativeName: "NoGap Probe",
      shortLabel: "NG",
      requiresApproval: false,
      studentVisible: true,
    },
    update: {},
    select: { code: true },
  });

  const created = await upsertItem(db, author, {
    type: "TEXT",
    topicId,
    licenseClassId,
    difficulty: 3,
    content: { en: OLD_EN, nb: nb(OLD_EN) },
    correctOptionKey: "a",
    legalCitations: [{ sourceCode: "trafikkreglene", ref: "§ 7" }],
  });
  itemId = created.id;
  await transitionItem(db, author, { id: itemId, to: "IN_REVIEW" });
  await transitionItem(db, reviewer, { id: itemId, to: "APPROVED" });

  await db.translation.create({
    data: {
      locale: LOCALE,
      entity: "MASTER_ITEM",
      entityId: itemId,
      value: STALE,
      status: "MACHINE",
      sourceHash: contentFingerprint({ en: OLD_EN, nb: nb(OLD_EN) }),
    },
  });
});

afterAll(async () => {
  await db.translation.deleteMany({ where: { locale: LOCALE } });
  await db.masterItem.deleteMany({ where: { topicId } });
  await db.topic.deleteMany({ where: { id: topicId } });
  await db.language.deleteMany({ where: { code: LOCALE } });
  await db.user.deleteMany({ where: { email: { contains: `-${RUN}@` } } });
  await redis.quit().catch(() => undefined);
});

d("the no-gap swap", () => {
  it("serves the translation before the rewrite", async () => {
    const served = await servedText();
    expect(served.stem).toBe(STALE.stem);
  });

  it("NEVER serves the stale translation over the new English, and never falls back", async () => {
    const before = await db.masterItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { version: true, content: true },
    });

    await rewriteApprovedItemInPlace(db, {
      itemId,
      newContent: { en: NEW_EN, nb: nb(NEW_EN) },
      expectedVersion: before.version,
      expectedFingerprint: contentFingerprint(before.content),
      runId: `nogap-${RUN}`,
      actorId: author.id,
      // The whole point: the fresh translation goes in WITH the content.
      translations: [
        {
          locale: LOCALE,
          value: FRESH,
          status: "MACHINE",
          sourceHash: contentFingerprint({ en: NEW_EN, nb: nb(NEW_EN) }),
        },
      ],
    });

    const served = await servedText();

    // Property 1: not the stale text.
    expect(served.stem).not.toBe(STALE.stem);
    expect(served.options).not.toContain(STALE.options[0]!.text);

    // Property 2: not English either — the student stayed in their language.
    expect(served.stem).not.toBe(NEW_EN.stem);
    expect(served.stem).toBe(FRESH.stem);
    expect(served.options).toEqual(FRESH.options.map((o) => o.text));
  });

  it("rollback restores the OLD translation, not just the old English", async () => {
    // The data-loss case. The swap overwrites the translation row, so unless the old value was
    // snapshotted first, a rollback gives back the old English with the NEW short translation
    // still attached — the stale pairing this design exists to prevent, reintroduced by the undo.
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "item.simplified", entityId: itemId },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    const meta = audit.meta as {
      previousContent: unknown;
      versionFrom: number;
      previousTranslations: Array<Record<string, unknown>>;
    };

    expect(meta.previousTranslations).toBeDefined();
    expect(meta.previousTranslations).toHaveLength(1);
    expect((meta.previousTranslations[0]!.value as { stem: string }).stem).toBe(STALE.stem);

    await rollbackRewrite(db, {
      itemId,
      previousContent: meta.previousContent as never,
      versionFrom: meta.versionFrom,
      translations: meta.previousTranslations.map((t) => ({
        locale: t.locale as string,
        value: t.value as never,
        status: t.status as never,
        sourceHash: t.sourceHash as string,
        qaFlags: (t.qaFlags ?? []) as string[],
      })),
      actorId: author.id,
      runId: `nogap-${RUN}`,
    });

    const served = await servedText();
    // Old English back, AND the translation that matched it.
    expect(served.stem).toBe(STALE.stem);
    expect(served.options).toEqual(STALE.options.map((o) => o.text));

    const master = await db.masterItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { version: true, content: true },
    });
    expect(master.version).toBe(1);
    expect((master.content as { en: { stem: string } }).en.stem).toBe(OLD_EN.stem);
  });

  it("would have served stale text if the translation had NOT been carried — the bug this prevents", async () => {
    // Demonstrates that the serving path really is blind to staleness, so the guarantee comes from
    // carrying the translation, not from any check downstream.
    await db.translation.update({
      where: {
        locale_entity_entityId: {
          locale: LOCALE,
          entity: "MASTER_ITEM",
          entityId: itemId,
        },
      },
      data: { value: STALE, sourceHash: "obviously-stale" },
    });

    const served = await servedText();
    // Stale sourceHash, still served: proof the overlay never checks it. This is the latent
    // serving bug the atomic swap works around, and it outlives this campaign.
    expect(served.stem).toBe(STALE.stem);
  });
});
