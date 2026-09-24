import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError } from "@/lib/errors";
import { createLearnService, type LearnService } from "./index";

/**
 * What a student can and cannot read (spec-23 C1, C4): only PUBLISHED documents of PUBLISHED
 * books; progress is monotonic and `readAt` is set once; the continue card picks the latest
 * unfinished document.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);
const db = url ? new PrismaClient({ datasourceUrl: url }) : (null as never);
let service: LearnService;
let topicId = "";
const actor = "learn-admin-2";
const student = "learn-student";
const body = { en: "## One\n\nText about the rule.\n\n## Two\n\nMore text.\n", nb: "## En\n\nTekst.\n\n## To\n\nMer.\n" };

async function doc(slug: string, kind: "ARTICLE" | "CHAPTER", bookId: string | null, publish = true) {
  const { id } = await service.upsertDocument(
    { kind, bookId, slug, topicId, title: { en: `T ${slug}`, nb: `T ${slug}` }, body, citations: [] },
    actor,
  );
  if (publish) await service.transitionDocument(id, "PUBLISHED", actor);
  return id;
}

d("student learn services", () => {
  beforeAll(async () => {
    await db.learnReadingProgress.deleteMany({});
    await db.learnCitation.deleteMany({});
    await db.learnDocument.deleteMany({});
    await db.learnBook.deleteMany({});
    await db.user.deleteMany({ where: { id: { in: [actor, student] } } });
    await db.user.createMany({
      data: [
        { id: actor, email: "learn-admin-2@test.local", role: "ADMIN" },
        { id: student, email: "learn-student@test.local", role: "STUDENT" },
      ],
    });
    await db.topic.deleteMany({ where: { slug: "lt" } });
    topicId = (await db.topic.create({ data: { slug: "lt", name: { en: "Topic", nb: "Emne" } } })).id;
    service = createLearnService(db);
  });
  afterAll(async () => {
    await db.learnReadingProgress.deleteMany({});
    await db.learnCitation.deleteMany({});
    await db.learnDocument.deleteMany({});
    await db.learnBook.deleteMany({});
    await db.topic.deleteMany({ where: { id: topicId } });
    await db.user.deleteMany({ where: { id: { in: [actor, student] } } });
    await db.$disconnect();
  });

  it("serves only published documents of published books, and hides drafts everywhere", async () => {
    const { id: publishedBook } = await service.upsertBook({ slug: "pub-book", title: { en: "P", nb: "P" } }, actor);
    const { id: draftBook } = await service.upsertBook({ slug: "draft-book", title: { en: "D", nb: "D" } }, actor);
    await service.transitionBook(publishedBook, "PUBLISHED", actor);
    await doc("pub-ch-1", "CHAPTER", publishedBook);
    await doc("pub-ch-draft", "CHAPTER", publishedBook, false);
    await doc("draft-book-ch", "CHAPTER", draftBook);
    await doc("art-pub", "ARTICLE", null);
    await doc("art-draft", "ARTICLE", null, false);

    const hub = await service.hub("en", student, { page: 1, pageSize: 20 });
    expect(hub.books.map((b) => b.slug)).toEqual(["pub-book"]);
    expect(hub.books[0]!.chapterCount).toBe(1);
    expect(hub.articles.items.map((a) => a.slug)).toEqual(["art-pub"]);
    expect(hub.topics).toContainEqual({ id: topicId, name: "Topic", count: 1 });

    const book = await service.bookPage("en", student, "pub-book");
    expect(book.chapters.map((c) => c.slug)).toEqual(["pub-ch-1"]);
    await expect(service.bookPage("en", student, "draft-book")).rejects.toBeInstanceOf(NotFoundError);

    await expect(service.reader("en", student, "draft-book-ch")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.reader("en", student, "pub-ch-draft")).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.reader("en", student, "art-draft")).rejects.toBeInstanceOf(NotFoundError);
    const reader = await service.reader("nb", student, "pub-ch-1");
    expect(reader.bodyMarkdown).toContain("## En");
    expect(reader.servedLocale).toBe("nb");
    expect(reader.book).toEqual({ slug: "pub-book", title: "P", chapterOrder: 1, chapterCount: 1 });
  });

  it("orders prev/next by the published chapters only", async () => {
    const { id: bookId } = await service.upsertBook({ slug: "nav-book", title: { en: "N", nb: "N" } }, actor);
    await service.transitionBook(bookId, "PUBLISHED", actor);
    await doc("nav-1", "CHAPTER", bookId);
    await doc("nav-2-draft", "CHAPTER", bookId, false);
    await doc("nav-3", "CHAPTER", bookId);
    const middle = await service.reader("en", student, "nav-3");
    expect(middle.prev?.slug).toBe("nav-1");
    expect(middle.next).toBeNull();
    expect(middle.book?.chapterOrder).toBe(2);
    expect(middle.book?.chapterCount).toBe(2);
  });

  it("keeps progress monotonic, sets readAt once, and feeds the continue card", async () => {
    const id = (await db.learnDocument.findUniqueOrThrow({ where: { slug: "nav-1" }, select: { id: true } })).id;
    const first = await service.recordProgress(student, { documentId: id, positionPct: 40, markRead: false });
    expect(first).toEqual({ readAt: null, positionPct: 40 });
    const back = await service.recordProgress(student, { documentId: id, positionPct: 10, markRead: false });
    expect(back.positionPct).toBe(40);

    const cont = await service.continueReading("en", student);
    expect(cont?.slug).toBe("nav-1");
    expect(cont?.positionPct).toBe(40);
    expect(cont?.bookTitle).toBe("N");

    const done = await service.recordProgress(student, { documentId: id, positionPct: 96, markRead: false });
    expect(done.readAt).toBeInstanceOf(Date);
    const later = await service.recordProgress(student, { documentId: id, positionPct: 50, markRead: false });
    expect(later.readAt?.getTime()).toBe(done.readAt?.getTime());
    expect(later.positionPct).toBe(96);

    expect(await service.continueReading("en", student)).toBeNull();
    const page = await service.bookPage("en", student, "nav-book");
    expect(page.readCount).toBe(1);
    expect(page.nextUnreadSlug).toBe("nav-3");
    const reader = await service.reader("en", student, "nav-1");
    expect(reader.progress.readAt).toBeInstanceOf(Date);
    expect(reader.progress.updatedSinceRead).toBe(false);
  });

  it("flags a chapter edited after it was read", async () => {
    const row = await db.learnDocument.findUniqueOrThrow({ where: { slug: "nav-1" }, select: { id: true } });
    await service.upsertDocument(
      { id: row.id, kind: "CHAPTER", bookId: (await db.learnDocument.findUniqueOrThrow({ where: { id: row.id }, select: { bookId: true } })).bookId, slug: "nav-1", topicId, title: { en: "T nav-1", nb: "T nav-1" }, body: { en: body.en + "\nChanged.\n", nb: body.nb }, citations: [] },
      actor,
    );
    const reader = await service.reader("en", student, "nav-1");
    expect(reader.progress.updatedSinceRead).toBe(true);
  });

  it("ignores progress on a draft document", async () => {
    const draft = await db.learnDocument.findUniqueOrThrow({ where: { slug: "art-draft" }, select: { id: true } });
    expect(await service.recordProgress(student, { documentId: draft.id, positionPct: 100, markRead: true })).toEqual({ readAt: null, positionPct: 0 });
  });
});
