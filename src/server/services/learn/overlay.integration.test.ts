import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractAll } from "@/server/services/i18n/extract";
import { countsTowardReadiness } from "@/server/services/i18n/languages";
import { createLearnService, type LearnService } from "./index";
import { documentUnits, extractLearnUnits, loadLearnDocumentOverlay } from "./overlay";

/**
 * Learn units through the real extractor and back through the overlay (spec-23 C9): only
 * published content is extracted, a translated document is served whole, and a stale section
 * makes the whole document fall back.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);
const db = url ? new PrismaClient({ datasourceUrl: url }) : (null as never);
let service: LearnService;
let topicId = "";
const actor = "learn-admin-3";
const LOCALE = "zzlearn";
const body = { en: "## One\n\nFirst rule.\n\n## Two\n\nSecond rule.\n", nb: "## En\n\nFørste regel.\n\n## To\n\nAndre regel.\n" };

d("learn overlay", () => {
  beforeAll(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "LearnReadingProgress","LearnCitation","LearnDocument","LearnBook","Translation","Topic","User" CASCADE`);
    await db.language.deleteMany({ where: { code: LOCALE } });
    await db.user.create({ data: { id: actor, email: "learn-admin-3@test.local", role: "ADMIN" } });
    topicId = (await db.topic.create({ data: { slug: "lo", name: { en: "Topic", nb: "Emne" } } })).id;
    await db.language.create({
      data: { code: LOCALE, englishName: "Test", nativeName: "Test", shortLabel: "ZZ", urlPrefix: `/${LOCALE}`, direction: "LTR", requiresApproval: false, studentVisible: true, sortOrder: 99 },
    });
    service = createLearnService(db);
  });
  afterAll(async () => {
    await db.translation.deleteMany({ where: { locale: LOCALE } });
    await db.language.deleteMany({ where: { code: LOCALE } });
    await db.$disconnect();
  });

  it("extracts only published documents of published books, as document + section units", async () => {
    const { id: bookId } = await service.upsertBook({ slug: "ov-book", title: { en: "B", nb: "B" } }, actor);
    const ch = await service.upsertDocument({ kind: "CHAPTER", bookId, slug: "ov-ch", topicId, title: { en: "Ch", nb: "Kap" }, body, citations: [] }, actor);
    const art = await service.upsertDocument({ kind: "ARTICLE", bookId: null, slug: "ov-art", topicId, title: { en: "Art", nb: "Art" }, body, citations: [] }, actor);
    await service.upsertDocument({ kind: "ARTICLE", bookId: null, slug: "ov-draft", topicId, title: { en: "D", nb: "D" }, body, citations: [] }, actor);
    await service.transitionDocument(ch.id, "PUBLISHED", actor);
    await service.transitionDocument(art.id, "PUBLISHED", actor);

    let units = await extractLearnUnits(db, 1);
    // the chapter's book is still DRAFT: only the article travels
    expect(units.map((u) => `${u.entity}:${u.entityId}`).sort()).toEqual([`LEARN_DOCUMENT:${art.id}`, `LEARN_SECTION:${art.id}:s0`, `LEARN_SECTION:${art.id}:s1`]);

    await service.transitionBook(bookId, "PUBLISHED", actor);
    units = await extractLearnUnits(db, 1);
    expect(units.filter((u) => u.entity === "LEARN_BOOK").map((u) => u.entityId)).toEqual([bookId]);
    expect(units.filter((u) => u.entity === "LEARN_DOCUMENT").map((u) => u.entityId).sort()).toEqual([art.id, ch.id].sort());

    // through the real extractor, with ids narrowing to one section
    const all = await extractAll(db, { glossaryVersion: 1 });
    expect(all.some((u) => u.entity === "LEARN_SECTION" && u.entityId === `${ch.id}:s1`)).toBe(true);
    const one = await extractAll(db, { glossaryVersion: 1, only: ["LEARN_SECTION"], ids: [`${ch.id}:s1`] });
    expect(one.map((u) => u.entityId)).toEqual([`${ch.id}:s1`]);
    // readiness ignores them
    expect(all.filter((u) => countsTowardReadiness(u.entity)).some((u) => u.entity.startsWith("LEARN_"))).toBe(false);
  });

  it("serves the translated document whole, and falls back entirely when one section is stale", async () => {
    const art = await db.learnDocument.findUniqueOrThrow({ where: { slug: "ov-art" }, select: { id: true, title: true, summary: true, body: true } });
    const units = documentUnits(art, 1);
    for (const unit of units) {
      await db.translation.create({
        data: {
          locale: LOCALE,
          entity: unit.entity,
          entityId: unit.entityId,
          value: unit.entity === "LEARN_DOCUMENT" ? { title: "Art (zz)" } : { text: (unit.en as { text: string }).text.replace("rule", "regle") },
          status: "MACHINE",
          sourceHash: unit.sourceHash,
          sourceLocale: "en",
        },
      });
    }
    const served = await service.reader(LOCALE, actor, "ov-art");
    expect(served.inLocale).toBe(true);
    expect(served.title).toBe("Art (zz)");
    expect(served.bodyMarkdown).toContain("First regle.");
    expect(served.bodyMarkdown).toContain("Second regle.");
    expect(served.servedLocale).toBe(LOCALE);

    // Edit one section: its hash moves, the old row is stale, the whole document falls back.
    await service.upsertDocument({ id: art.id, kind: "ARTICLE", bookId: null, slug: "ov-art", topicId, title: { en: "Art", nb: "Art" }, body: { en: body.en.replace("Second rule.", "Second rule, changed."), nb: body.nb }, citations: [] }, actor);
    const again = await db.learnDocument.findUniqueOrThrow({ where: { id: art.id }, select: { id: true, title: true, summary: true, body: true } });
    const overlay = await loadLearnDocumentOverlay(db, LOCALE, [again]);
    expect(overlay.has(art.id)).toBe(false);
    const fallback = await service.reader(LOCALE, actor, "ov-art");
    expect(fallback.inLocale).toBe(false);
    expect(fallback.title).toBe("Art");
    expect(fallback.bodyMarkdown).toContain("Second rule, changed.");
    expect(fallback.servedLocale).toBe("en");

    // a language that requires approval never serves MACHINE
    await db.language.update({ where: { code: LOCALE }, data: { requiresApproval: true } });
    const before = await db.learnDocument.findUniqueOrThrow({ where: { id: art.id }, select: { id: true, title: true, summary: true, body: true } });
    expect((await loadLearnDocumentOverlay(db, LOCALE, [before])).size).toBe(0);
  });
});
