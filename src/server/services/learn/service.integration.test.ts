import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { createLearnService, type LearnService } from "./index";

/**
 * Books, chapters and articles against a real Postgres (teoripro_test) — spec-23 C1, C5, C13.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);
const db = url ? new PrismaClient({ datasourceUrl: url }) : (null as never);
let service: LearnService;
let topicId = "";
let chunkId = "";
const actor = "learn-admin";

const md = (n: number) => `## Section ${n}\n\nSome words about rule ${n} (trafikkreglene § 7 nr. 2).\n`;
const doc = (slug: string, kind: "ARTICLE" | "CHAPTER", bookId: string | null, extra: Record<string, unknown> = {}) => ({
  kind,
  bookId,
  slug,
  topicId,
  title: { en: `Title ${slug}`, nb: `Tittel ${slug}` },
  summary: { en: "sum", nb: "sam" },
  body: { en: md(1), nb: md(1) },
  citations: [],
  ...extra,
});

d("learn services", () => {
  beforeAll(async () => {
    await db.$executeRawUnsafe(`
      TRUNCATE "LearnReadingProgress","LearnCitation","LearnDocument","LearnBook",
        "KbChunk","KbSource","Topic","User" CASCADE
    `);
    await db.user.create({ data: { id: actor, email: "learn-admin@test.local", role: "ADMIN" } });
    const topic = await db.topic.create({ data: { slug: "learn-topic", name: { en: "Right of way", nb: "Vikeplikt" } } });
    topicId = topic.id;
    const source = await db.kbSource.create({ data: { code: "trafikkreglene", kind: "REGULATION", name: "Trafikkreglene" } });
    const chunk = await db.kbChunk.create({
      data: { sourceId: source.id, ref: "§ 7", text: "Section seven.", isActive: true },
    });
    chunkId = chunk.id;
    service = createLearnService(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates a book, refuses a duplicate slug, and reads it back", async () => {
    const { id } = await service.upsertBook({ slug: "theory-book", title: { en: "Theory", nb: "Teori" } }, actor);
    await expect(
      service.upsertBook({ slug: "theory-book", title: { en: "Other", nb: "Annen" } }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    const book = await service.getBookAdmin(id);
    expect(book.status).toBe("DRAFT");
    expect(book.chapters).toEqual([]);
  });

  it("numbers chapters on creation and reorders the whole list in one write", async () => {
    const { id: bookId } = await service.upsertBook({ slug: "ordered", title: { en: "Ordered", nb: "Ordnet" } }, actor);
    await expect(service.upsertDocument(doc("ch-x", "CHAPTER", null), actor)).rejects.toThrow();
    const a = await service.upsertDocument(doc("ch-a", "CHAPTER", bookId), actor);
    const b = await service.upsertDocument(doc("ch-b", "CHAPTER", bookId), actor);
    const c = await service.upsertDocument(doc("ch-c", "CHAPTER", bookId), actor);
    let book = await service.getBookAdmin(bookId);
    expect(book.chapters.map((ch) => [ch.slug, ch.chapterOrder])).toEqual([["ch-a", 1], ["ch-b", 2], ["ch-c", 3]]);

    await service.reorderChapters({ bookId, documentIds: [c.id, a.id, b.id] }, actor);
    book = await service.getBookAdmin(bookId);
    expect(book.chapters.map((ch) => [ch.slug, ch.chapterOrder])).toEqual([["ch-c", 1], ["ch-a", 2], ["ch-b", 3]]);
    expect(new Set(book.chapters.map((ch) => ch.chapterOrder)).size).toBe(3);

    await expect(service.reorderChapters({ bookId, documentIds: [a.id, b.id] }, actor)).rejects.toBeInstanceOf(ValidationError);
    await expect(service.reorderChapters({ bookId, documentIds: [a.id, a.id, b.id] }, actor)).rejects.toBeInstanceOf(ValidationError);
  });

  it("publishes only a complete document, sets publishedAt once, and keeps it through unpublish", async () => {
    const { id } = await service.upsertDocument(doc("art-1", "ARTICLE", null, { body: { en: md(1), nb: "" } }), actor);
    await expect(service.transitionDocument(id, "PUBLISHED", actor)).rejects.toBeInstanceOf(ValidationError);

    await service.upsertDocument({ ...doc("art-1", "ARTICLE", null), id }, actor);
    await service.transitionDocument(id, "PUBLISHED", actor);
    const published = await service.getDocumentAdmin(id);
    expect(published.status).toBe("PUBLISHED");
    expect(published.publishedAt).toBeInstanceOf(Date);

    await service.transitionDocument(id, "DRAFT", actor);
    await service.transitionDocument(id, "PUBLISHED", actor);
    const again = await service.getDocumentAdmin(id);
    expect(again.publishedAt?.getTime()).toBe(published.publishedAt?.getTime());
  });

  it("bumps the version only when a student would read something different", async () => {
    const first = await service.upsertDocument(doc("art-v", "ARTICLE", null), actor);
    expect(first.version).toBe(1);
    const same = await service.upsertDocument({ ...doc("art-v", "ARTICLE", null), id: first.id }, actor);
    expect(same.version).toBe(1);
    const changed = await service.upsertDocument(
      { ...doc("art-v", "ARTICLE", null), id: first.id, body: { en: md(2), nb: md(2) } },
      actor,
    );
    expect(changed.version).toBe(2);
    const read = await service.getDocumentAdmin(first.id);
    expect(read.wordCount.en).toBeGreaterThan(0);
  });

  it("links resolvable citations to chunks and refuses an unknown source", async () => {
    const { id } = await service.upsertDocument(
      doc("art-cite", "ARTICLE", null, { citations: [{ sourceCode: "trafikkreglene", ref: "§ 7 nr. 3" }] }),
      actor,
    );
    const rows = await db.learnCitation.findMany({ where: { documentId: id }, select: { kbChunkId: true, ref: true } });
    expect(rows).toEqual([{ kbChunkId: chunkId, ref: "§ 7 nr. 3" }]);
    const admin = await service.getDocumentAdmin(id);
    expect(admin.unresolvedCitations).toEqual([]);

    await expect(
      service.upsertDocument(doc("art-bad", "ARTICLE", null, { citations: [{ sourceCode: "nope", ref: "§ 1" }] }), actor),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body that embeds an image this app does not have", async () => {
    await expect(
      service.upsertDocument(
        doc("art-img", "ARTICLE", null, { body: { en: "![x](/api/images/nope123)", nb: "tekst" } }),
        actor,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps kind and book fixed after creation", async () => {
    const { id: bookId } = await service.upsertBook({ slug: "fixed", title: { en: "F", nb: "F" } }, actor);
    const ch = await service.upsertDocument(doc("ch-fixed", "CHAPTER", bookId), actor);
    await expect(
      service.upsertDocument({ ...doc("ch-fixed", "ARTICLE", null), id: ch.id }, actor),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("deleting a book takes its chapters with it, softly", async () => {
    const { id: bookId } = await service.upsertBook({ slug: "gone", title: { en: "G", nb: "G" } }, actor);
    const ch = await service.upsertDocument(doc("ch-gone", "CHAPTER", bookId), actor);
    await service.deleteBook(bookId, actor);
    await expect(service.getBookAdmin(bookId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getDocumentAdmin(ch.id)).rejects.toBeInstanceOf(NotFoundError);
    const row = await db.learnDocument.findUnique({ where: { id: ch.id }, select: { deletedAt: true } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("lists by tab, status and title search, with the book's title on a chapter", async () => {
    const chapters = await service.listAdmin({ tab: "CHAPTERS", page: 1, pageSize: 50 }, "en");
    expect(chapters.items.every((row) => row.kind === "CHAPTER" && row.bookTitle !== null)).toBe(true);
    expect(chapters.items.some((row) => row.slug === "ch-gone")).toBe(false);

    const published = await service.listAdmin({ tab: "ARTICLES", status: "PUBLISHED", page: 1, pageSize: 50 }, "en");
    expect(published.items.map((row) => row.slug)).toEqual(["art-1"]);

    const searched = await service.listAdmin({ tab: "ARTICLES", search: "art-v", page: 1, pageSize: 50 }, "en");
    expect(searched.items.map((row) => row.slug)).toEqual(["art-v"]);

    const books = await service.listAdmin({ tab: "BOOKS", page: 1, pageSize: 2 }, "en");
    expect(books.items).toHaveLength(2);
    expect(books.totalCount).toBeGreaterThanOrEqual(3);
    expect(books.items.every((row) => row.entity === "BOOK" && row.chapterCount !== null)).toBe(true);
  });
});
