import type { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { pickBilingualText } from "@/lib/i18n-content";
import {
  adminBookSchema,
  adminLearnPageSchema,
  listLearnAdminInputSchema,
  reorderChaptersInputSchema,
  transitionLearnInputSchema,
  upsertBookInputSchema,
  type AdminBook,
  type AdminLearnPage,
  type LearnStatus,
} from "@/server/contracts/learn";
import { requestTranslationSync } from "@/server/services/i18n/sync";
import { invalidateLearn } from "./cache";
import { assertImageExists, assertLicenseClass } from "./checks";

/**
 * Books and the admin list (spec-23). A book is an ordered set of chapters; it carries no text of
 * its own beyond a title and a description, so most of the rules live in `documents.ts`.
 */
export function createBookService(db: PrismaClient) {
  async function listAdmin(rawInput: unknown, locale: string): Promise<AdminLearnPage> {
    const input = listLearnAdminInputSchema.parse(rawInput);
    const skip = (input.page - 1) * input.pageSize;
    const search = input.search?.trim();
    const titleSearch = search
      ? {
          OR: [
            { title: { path: ["en"], string_contains: search } },
            { title: { path: ["nb"], string_contains: search } },
          ],
        }
      : {};

    if (input.tab === "BOOKS") {
      // Index: LearnBook_status_sortOrder_idx (status filter), else a small full scan — a school
      // has tens of books, not thousands.
      const where: Prisma.LearnBookWhereInput = {
        deletedAt: null,
        ...(input.status ? { status: input.status } : {}),
        ...titleSearch,
      };
      const [rows, totalCount] = await db.$transaction([
        db.learnBook.findMany({
          where,
          select: {
            id: true,
            slug: true,
            title: true,
            status: true,
            updatedAt: true,
            publishedAt: true,
            _count: { select: { chapters: { where: { deletedAt: null } } } },
          },
          orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
          skip,
          take: input.pageSize,
        }),
        db.learnBook.count({ where }),
      ]);
      return adminLearnPageSchema.parse({
        items: rows.map((row) => ({
          id: row.id,
          entity: "BOOK",
          kind: null,
          slug: row.slug,
          title: row.title,
          status: row.status,
          topicName: null,
          bookTitle: null,
          chapterCount: row._count.chapters,
          wordCountEn: null,
          updatedAt: row.updatedAt,
          publishedAt: row.publishedAt,
        })),
        page: input.page,
        pageSize: input.pageSize,
        totalCount,
      });
    }

    // Index: LearnDocument_kind_status_publishedAt_idx; LearnDocument_topicId_status_idx when
    // filtered by topic.
    const where: Prisma.LearnDocumentWhereInput = {
      deletedAt: null,
      kind: input.tab === "CHAPTERS" ? "CHAPTER" : "ARTICLE",
      ...(input.status ? { status: input.status } : {}),
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...titleSearch,
    };
    const [rows, totalCount] = await db.$transaction([
      db.learnDocument.findMany({
        where,
        select: {
          id: true,
          kind: true,
          slug: true,
          title: true,
          status: true,
          wordCount: true,
          updatedAt: true,
          publishedAt: true,
          topic: { select: { name: true } },
          book: { select: { title: true } },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take: input.pageSize,
      }),
      db.learnDocument.count({ where }),
    ]);
    return adminLearnPageSchema.parse({
      items: rows.map((row) => ({
        id: row.id,
        entity: "DOCUMENT",
        kind: row.kind,
        slug: row.slug,
        title: row.title,
        status: row.status,
        topicName: pickBilingualText(row.topic.name, locale),
        bookTitle: row.book ? pickBilingualText(row.book.title, locale) : null,
        chapterCount: null,
        wordCountEn: (row.wordCount as { en?: number }).en ?? 0,
        updatedAt: row.updatedAt,
        publishedAt: row.publishedAt,
      })),
      page: input.page,
      pageSize: input.pageSize,
      totalCount,
    });
  }

  async function getBookAdmin(id: string): Promise<AdminBook> {
    const book = await db.learnBook.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        coverImageId: true,
        licenseClassId: true,
        status: true,
        sortOrder: true,
        publishedAt: true,
        // Index: LearnDocument_bookId_chapterOrder_idx
        chapters: {
          where: { deletedAt: null },
          select: { id: true, slug: true, title: true, status: true, chapterOrder: true, wordCount: true },
          orderBy: { chapterOrder: "asc" },
        },
      },
    });
    if (!book) throw new NotFoundError({ bookId: id });
    return adminBookSchema.parse({
      ...book,
      chapters: book.chapters.map((chapter) => ({
        ...chapter,
        wordCountEn: (chapter.wordCount as { en?: number }).en ?? 0,
      })),
    });
  }

  async function upsertBook(rawInput: unknown, actorId: string): Promise<{ id: string }> {
    const input = upsertBookInputSchema.parse(rawInput);
    const slugOwner = await db.learnBook.findUnique({ where: { slug: input.slug }, select: { id: true } });
    if (slugOwner && slugOwner.id !== input.id) {
      throw new ConflictError({ slug: input.slug }, "admin.learn.errors.slugTaken");
    }
    if (input.coverImageId) await assertImageExists(db, input.coverImageId);
    if (input.licenseClassId) await assertLicenseClass(db, input.licenseClassId);

    const data = {
      slug: input.slug,
      title: input.title as Prisma.InputJsonValue,
      description: (input.description ?? null) as Prisma.InputJsonValue,
      coverImageId: input.coverImageId,
      licenseClassId: input.licenseClassId,
      sortOrder: input.sortOrder,
      updatedById: actorId,
    };
    let id: string;
    if (input.id) {
      const existing = await db.learnBook.findFirst({ where: { id: input.id, deletedAt: null }, select: { id: true } });
      if (!existing) throw new NotFoundError({ bookId: input.id });
      await db.learnBook.update({ where: { id: input.id }, data, select: { id: true } });
      id = input.id;
    } else {
      const created = await db.learnBook.create({
        data: { ...data, createdById: actorId },
        select: { id: true },
      });
      id = created.id;
    }
    await invalidateLearn();
    return { id };
  }

  /** Rewrite the whole order in one transaction — the list must name every live chapter exactly once. */
  async function reorderChapters(rawInput: unknown, actorId: string): Promise<void> {
    const input = reorderChaptersInputSchema.parse(rawInput);
    const live = await db.learnDocument.findMany({
      where: { bookId: input.bookId, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((row) => row.id));
    const given = new Set(input.documentIds);
    if (
      given.size !== input.documentIds.length ||
      given.size !== liveIds.size ||
      [...given].some((id) => !liveIds.has(id))
    ) {
      throw new ValidationError({ bookId: input.bookId }, "admin.learn.errors.reorderMismatch");
    }
    await db.$transaction(
      input.documentIds.map((id, position) =>
        db.learnDocument.update({
          where: { id },
          data: { chapterOrder: position + 1, updatedById: actorId },
          select: { id: true },
        }),
      ),
    );
    await invalidateLearn();
  }

  async function transitionBook(id: string, to: LearnStatus, actorId: string): Promise<void> {
    transitionLearnInputSchema.parse({ entity: "BOOK", id, to });
    const book = await db.learnBook.findFirst({
      where: { id, deletedAt: null },
      select: { status: true, publishedAt: true },
    });
    if (!book) throw new NotFoundError({ bookId: id });
    if (book.status === to) return;
    await db.learnBook.update({
      where: { id },
      data: {
        status: to,
        updatedById: actorId,
        ...(to === "PUBLISHED" && !book.publishedAt ? { publishedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    await invalidateLearn();
    if (to === "PUBLISHED") await requestTranslationSync(db);
  }

  /** Soft delete; chapters go with the book. */
  async function deleteBook(id: string, actorId: string): Promise<void> {
    const book = await db.learnBook.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!book) throw new NotFoundError({ bookId: id });
    const now = new Date();
    await db.$transaction([
      db.learnDocument.updateMany({
        where: { bookId: id, deletedAt: null },
        data: { deletedAt: now, updatedById: actorId },
      }),
      db.learnBook.update({ where: { id }, data: { deletedAt: now, updatedById: actorId }, select: { id: true } }),
    ]);
    await invalidateLearn();
  }

  return { listAdmin, getBookAdmin, upsertBook, reorderChapters, transitionBook, deleteBook };
}

export type BookService = ReturnType<typeof createBookService>;
