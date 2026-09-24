import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { pickBilingualText } from "@/lib/i18n-content";
import { isBuiltinLocale } from "@/lib/locale";
import { keys } from "@/server/redis";
import {
  bookPageSchema,
  continueReadingSchema,
  hubQuerySchema,
  hubSchema,
  readerDocumentSchema,
  type BookPage,
  type ContinueReading,
  type Hub,
  type ReaderDocument,
} from "@/server/contracts/learn";
import { cachedLearn } from "./cache";
import { readMinutes } from "./markdown";
import { loadLearnBookOverlay, loadLearnDocumentOverlay } from "./overlay";

/**
 * What a student reads (spec-23). Two layers on purpose: the PUBLIC part of every page — the
 * published books, chapters and text for one locale — is cached under the Learn version, and the
 * per-user part (progress) is one primary-key query merged on top, never cached.
 *
 * Only PUBLISHED documents of PUBLISHED books are ever returned here (C1). The locale overlay
 * for non-authoring languages is wired by slice 4; until then `inLocale` is honest about it.
 */
const PUBLISHED_DOC = { status: "PUBLISHED" as const, deletedAt: null };

function words(wordCount: unknown, locale: string): number {
  const counts = (wordCount ?? {}) as { en?: number; nb?: number };
  return (locale === "nb" ? counts.nb : counts.en) ?? counts.en ?? 0;
}

export function createStudentLearnService(db: PrismaClient) {
  async function publicHub(locale: string, topicId: string | undefined, page: number, pageSize: number) {
    const builtin = isBuiltinLocale(locale);
    return cachedLearn(
      (version) => keys.learnHub(version, `${locale}:${topicId ?? "all"}:${page}:${pageSize}`),
      async () => {
        // Index: LearnBook_status_sortOrder_idx.
        const books = await db.learnBook.findMany({
          where: { status: "PUBLISHED", deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            coverImageId: true,
            licenseClass: { select: { code: true } },
            chapters: { where: PUBLISHED_DOC, select: { id: true } },
          },
          orderBy: [{ sortOrder: "asc" }, { publishedAt: "desc" }],
        });
        const bookOverlay = await loadLearnBookOverlay(db, locale, books);
        // Index: LearnDocument_kind_status_publishedAt_idx, or _topicId_status_idx when filtered.
        const where = { kind: "ARTICLE" as const, ...PUBLISHED_DOC, ...(topicId ? { topicId } : {}) };
        const topicRows = await db.learnDocument.groupBy({
          by: ["topicId"],
          where: { kind: "ARTICLE", ...PUBLISHED_DOC },
          _count: { topicId: true },
          orderBy: { topicId: "asc" },
        });
        const [articles, totalCount] = await db.$transaction([
          db.learnDocument.findMany({
            where,
            select: {
              id: true,
              slug: true,
              title: true,
              summary: true,
              body: true,
              heroImageId: true,
              wordCount: true,
              topic: { select: { id: true, name: true } },
            },
            orderBy: { publishedAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          db.learnDocument.count({ where }),
        ]);
        const topicNames = await db.topic.findMany({
          where: { id: { in: topicRows.map((row) => row.topicId) } },
          select: { id: true, name: true, sortOrder: true },
          orderBy: { sortOrder: "asc" },
        });
        const docOverlay = await loadLearnDocumentOverlay(db, locale, articles);
        return {
          books: books.map((book) => {
            const tr = bookOverlay.get(book.id);
            return {
              id: book.id,
              slug: book.slug,
              title: tr?.title ?? pickBilingualText(book.title, locale),
              description: tr ? tr.description : book.description ? pickBilingualText(book.description, locale) || null : null,
              coverImageId: book.coverImageId,
              chapterIds: book.chapters.map((c) => c.id),
              licenseClassCode: book.licenseClass?.code ?? null,
              inLocale: builtin || Boolean(tr),
            };
          }),
          articles: articles.map((doc) => {
            const tr = docOverlay.get(doc.id);
            return {
              id: doc.id,
              slug: doc.slug,
              title: tr?.title ?? pickBilingualText(doc.title, locale),
              summary: tr ? tr.summary : doc.summary ? pickBilingualText(doc.summary, locale) || null : null,
              topicName: pickBilingualText(doc.topic.name, locale),
              readMinutes: readMinutes(words(doc.wordCount, locale)),
              heroImageId: doc.heroImageId,
              inLocale: builtin || Boolean(tr),
            };
          }),
          totalCount,
          topics: topicNames.map((topic) => ({
            id: topic.id,
            name: pickBilingualText(topic.name, locale),
            count: topicRows.find((row) => row.topicId === topic.id)?._count.topicId ?? 0,
          })),
        };
      },
    );
  }

  async function hub(locale: string, userId: string, rawQuery: unknown): Promise<Hub> {
    const query = hubQuerySchema.parse(rawQuery);
    const pub = await publicHub(locale, query.topicId, query.page, query.pageSize);
    const ids = [...pub.books.flatMap((b) => b.chapterIds), ...pub.articles.map((a) => a.id)];
    // PK prefix (userId, documentId) — one query for the whole page.
    const progress = ids.length
      ? await db.learnReadingProgress.findMany({
          where: { userId, documentId: { in: ids } },
          select: { documentId: true, readAt: true },
        })
      : [];
    const readAt = new Map(progress.map((row) => [row.documentId, row.readAt]));
    return hubSchema.parse({
      books: pub.books.map(({ chapterIds, ...book }) => ({
        ...book,
        chapterCount: chapterIds.length,
        readChapters: chapterIds.filter((id) => readAt.get(id)).length,
      })),
      articles: {
        items: pub.articles.map((article) => ({ ...article, readAt: readAt.get(article.id) ?? null })),
        page: query.page,
        pageSize: query.pageSize,
        totalCount: pub.totalCount,
      },
      topics: pub.topics,
      continue: await continueReading(locale, userId),
    });
  }

  async function publicBook(locale: string, slug: string) {
    return cachedLearn(
      (version) => keys.learnBook(version, locale, slug),
      async () => {
        const book = await db.learnBook.findFirst({
          where: { slug, status: "PUBLISHED", deletedAt: null },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            coverImageId: true,
            // Index: LearnDocument_bookId_chapterOrder_idx.
            chapters: {
              where: PUBLISHED_DOC,
              select: { id: true, slug: true, title: true, summary: true, body: true, chapterOrder: true, wordCount: true },
              orderBy: { chapterOrder: "asc" },
            },
          },
        });
        if (!book) return null;
        const [bookOverlay, chapterOverlay] = await Promise.all([
          loadLearnBookOverlay(db, locale, [book]),
          loadLearnDocumentOverlay(db, locale, book.chapters),
        ]);
        const tr = bookOverlay.get(book.id);
        return {
          id: book.id,
          slug: book.slug,
          title: tr?.title ?? pickBilingualText(book.title, locale),
          description: tr ? tr.description : book.description ? pickBilingualText(book.description, locale) || null : null,
          coverImageId: book.coverImageId,
          inLocale: isBuiltinLocale(locale) || Boolean(tr),
          chapters: book.chapters.map((chapter, index) => ({
            id: chapter.id,
            slug: chapter.slug,
            title: chapterOverlay.get(chapter.id)?.title ?? pickBilingualText(chapter.title, locale),
            chapterOrder: index + 1,
            readMinutes: readMinutes(words(chapter.wordCount, locale)),
          })),
        };
      },
    );
  }

  async function bookPage(locale: string, userId: string, slug: string): Promise<BookPage> {
    const pub = await publicBook(locale, slug);
    if (!pub) throw new NotFoundError({ slug });
    const progress = pub.chapters.length
      ? await db.learnReadingProgress.findMany({
          where: { userId, documentId: { in: pub.chapters.map((c) => c.id) } },
          select: { documentId: true, readAt: true, positionPct: true },
        })
      : [];
    const byId = new Map(progress.map((row) => [row.documentId, row]));
    const chapters = pub.chapters.map((chapter) => ({
      ...chapter,
      readAt: byId.get(chapter.id)?.readAt ?? null,
      positionPct: byId.get(chapter.id)?.positionPct ?? 0,
    }));
    return bookPageSchema.parse({
      book: { ...pub, chapters: undefined },
      chapters,
      readCount: chapters.filter((c) => c.readAt).length,
      nextUnreadSlug: chapters.find((c) => !c.readAt)?.slug ?? null,
    });
  }

  async function publicReader(locale: string, slug: string) {
    return cachedLearn(
      (version) => keys.learnDoc(version, locale, slug),
      async () => {
        const doc = await db.learnDocument.findFirst({
          where: { slug, ...PUBLISHED_DOC },
          select: {
            id: true,
            slug: true,
            kind: true,
            version: true,
            title: true,
            summary: true,
            body: true,
            heroImageId: true,
            wordCount: true,
            citations: true,
            topic: { select: { slug: true, name: true } },
            book: {
              select: {
                id: true,
                slug: true,
                title: true,
                status: true,
                deletedAt: true,
                chapters: {
                  where: PUBLISHED_DOC,
                  select: { id: true, slug: true, title: true, summary: true, body: true },
                  orderBy: { chapterOrder: "asc" },
                },
              },
            },
          },
        });
        if (!doc) return null;
        // A chapter is reachable only through a published book (C1).
        if (doc.kind === "CHAPTER" && (!doc.book || doc.book.status !== "PUBLISHED" || doc.book.deletedAt)) return null;

        const citations = ((doc.citations ?? []) as Array<{ sourceCode: string; ref: string }>).filter(
          (c) => c?.sourceCode && c?.ref,
        );
        const sources = citations.length
          ? await db.kbSource.findMany({
              where: { code: { in: [...new Set(citations.map((c) => c.sourceCode))] } },
              select: { code: true, name: true },
            })
          : [];
        const sourceName = new Map(sources.map((s) => [s.code, s.name]));

        const chapters = doc.book?.chapters ?? [];
        const position = chapters.findIndex((c) => c.id === doc.id);
        const [overlay, bookOverlay] = await Promise.all([
          loadLearnDocumentOverlay(db, locale, [doc, ...chapters.filter((c) => c.id !== doc.id)]),
          doc.book ? loadLearnBookOverlay(db, locale, [{ id: doc.book.id, title: doc.book.title, description: null }]) : Promise.resolve(new Map()),
        ]);
        const tr = overlay.get(doc.id);
        const sibling = (offset: number) => {
          const row = position >= 0 ? chapters[position + offset] : undefined;
          return row ? { slug: row.slug, title: overlay.get(row.id)?.title ?? pickBilingualText(row.title, locale) } : null;
        };
        return {
          id: doc.id,
          slug: doc.slug,
          kind: doc.kind,
          version: doc.version,
          title: tr?.title ?? pickBilingualText(doc.title, locale),
          summary: tr ? tr.summary : doc.summary ? pickBilingualText(doc.summary, locale) || null : null,
          bodyMarkdown: tr?.body ?? pickBilingualText(doc.body, locale),
          servedLocale: tr ? locale : locale === "nb" ? "nb" : "en",
          inLocale: isBuiltinLocale(locale) || Boolean(tr),
          heroImageId: doc.heroImageId,
          readMinutes: readMinutes(words(doc.wordCount, locale)),
          topic: { slug: doc.topic.slug, name: pickBilingualText(doc.topic.name, locale) },
          citations: citations.map((c) => ({ ...c, sourceName: sourceName.get(c.sourceCode) ?? c.sourceCode })),
          book:
            doc.kind === "CHAPTER" && doc.book
              ? {
                  slug: doc.book.slug,
                  title: bookOverlay.get(doc.book.id)?.title ?? pickBilingualText(doc.book.title, locale),
                  chapterOrder: position + 1,
                  chapterCount: chapters.length,
                }
              : null,
          prev: sibling(-1),
          next: sibling(1),
        };
      },
    );
  }

  async function reader(locale: string, userId: string, slug: string): Promise<ReaderDocument> {
    const pub = await publicReader(locale, slug);
    if (!pub) throw new NotFoundError({ slug });
    const progress = await db.learnReadingProgress.findUnique({
      where: { userId_documentId: { userId, documentId: pub.id } },
      select: { positionPct: true, readAt: true, readVersion: true },
    });
    return readerDocumentSchema.parse({
      ...pub,
      progress: {
        positionPct: progress?.positionPct ?? 0,
        readAt: progress?.readAt ?? null,
        updatedSinceRead: Boolean(progress?.readAt && progress.readVersion !== null && progress.readVersion < pub.version),
      },
    });
  }

  /** The most recently opened, unfinished, still-published document — or nothing. */
  async function continueReading(locale: string, userId: string): Promise<ContinueReading | null> {
    // Index: LearnReadingProgress_userId_lastOpenedAt_idx.
    const row = await db.learnReadingProgress.findFirst({
      where: { userId, readAt: null, document: PUBLISHED_DOC },
      orderBy: { lastOpenedAt: "desc" },
      select: {
        positionPct: true,
        document: {
          select: { slug: true, title: true, wordCount: true, kind: true, book: { select: { title: true, status: true, deletedAt: true } } },
        },
      },
    });
    if (!row) return null;
    if (row.document.kind === "CHAPTER" && (row.document.book?.status !== "PUBLISHED" || row.document.book.deletedAt)) return null;
    const minutes = readMinutes(words(row.document.wordCount, locale));
    return continueReadingSchema.parse({
      slug: row.document.slug,
      title: pickBilingualText(row.document.title, locale),
      bookTitle: row.document.book ? pickBilingualText(row.document.book.title, locale) : null,
      positionPct: row.positionPct,
      readMinutesLeft: Math.max(0, Math.round((minutes * (100 - row.positionPct)) / 100)),
    });
  }

  return { hub, bookPage, reader, continueReading };
}

export type StudentLearnService = ReturnType<typeof createStudentLearnService>;
