import type { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  adminDocumentSchema,
  transitionLearnInputSchema,
  upsertDocumentInputSchema,
  type AdminDocument,
  type LearnStatus,
} from "@/server/contracts/learn";
import { lookupChunksForCitations, usableCitations } from "@/server/services/kb/citations";
import { invalidateLearn } from "./cache";
import { assertImageExists, assertImagesExist, assertLicenseClass, assertSourcesExist, assertTopic } from "./checks";
import { countWords, extractImageIds } from "./markdown";

/**
 * Articles and chapters (spec-23). One model, one set of rules:
 * - a slug is global (the reader route is the same for both kinds);
 * - every image a body embeds must be a live upload of this app;
 * - `version` moves only when a student would read something different;
 * - publishing needs both languages present, and a chapter needs a live book.
 */
export function createDocumentService(db: PrismaClient) {
  async function getDocumentAdmin(id: string): Promise<AdminDocument> {
    const doc = await db.learnDocument.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        kind: true,
        bookId: true,
        book: { select: { id: true, title: true, status: true } },
        chapterOrder: true,
        slug: true,
        topicId: true,
        licenseClassId: true,
        title: true,
        summary: true,
        body: true,
        heroImageId: true,
        citations: true,
        status: true,
        publishedAt: true,
        version: true,
        wordCount: true,
        createdBy: true,
      },
    });
    if (!doc) throw new NotFoundError({ documentId: id });
    const citations = usableCitations(doc.citations);
    const { unresolved } = await lookupChunksForCitations(db, citations, { perCitation: 1 });
    return adminDocumentSchema.parse({ ...doc, citations, unresolvedCitations: unresolved });
  }

  async function upsertDocument(rawInput: unknown, actorId: string): Promise<{ id: string; version: number }> {
    const input = upsertDocumentInputSchema.parse(rawInput);

    const slugOwner = await db.learnDocument.findUnique({ where: { slug: input.slug }, select: { id: true } });
    if (slugOwner && slugOwner.id !== input.id) {
      throw new ConflictError({ slug: input.slug }, "admin.learn.errors.slugTaken");
    }
    await assertTopic(db, input.topicId);
    if (input.licenseClassId) await assertLicenseClass(db, input.licenseClassId);
    if (input.heroImageId) await assertImageExists(db, input.heroImageId);
    await assertImagesExist(db, [
      ...new Set([...extractImageIds(input.body.en), ...extractImageIds(input.body.nb)]),
    ]);
    await assertSourcesExist(db, input.citations.map((c) => c.sourceCode));
    if (input.kind === "CHAPTER") {
      const book = await db.learnBook.findFirst({ where: { id: input.bookId!, deletedAt: null }, select: { id: true } });
      if (!book) throw new ValidationError({ bookId: input.bookId }, "admin.learn.errors.bookMissing");
    }

    const wordCount = { en: countWords(input.body.en, "en"), nb: countWords(input.body.nb, "nb") };
    const content = {
      title: input.title as Prisma.InputJsonValue,
      summary: (input.summary ?? null) as Prisma.InputJsonValue,
      body: input.body as Prisma.InputJsonValue,
      citations: input.citations as Prisma.InputJsonValue,
    };
    const meta = {
      slug: input.slug,
      topicId: input.topicId,
      licenseClassId: input.licenseClassId,
      heroImageId: input.heroImageId,
      wordCount: wordCount as Prisma.InputJsonValue,
      updatedById: actorId,
    };
    const { resolved } = await lookupChunksForCitations(db, input.citations, { perCitation: 1 });
    const citationRows = resolved.map((c) => ({ kbChunkId: c.kbChunkId, sourceCode: c.sourceCode, ref: c.ref }));

    if (input.id) {
      const existing = await db.learnDocument.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, kind: true, bookId: true, title: true, summary: true, body: true, citations: true, version: true },
      });
      if (!existing) throw new NotFoundError({ documentId: input.id });
      // The kind and the book are fixed at creation: moving a chapter between books, or turning
      // it into an article, is a delete-and-recreate an admin does knowingly.
      if (existing.kind !== input.kind || (existing.bookId ?? null) !== (input.bookId ?? null)) {
        throw new ValidationError({ documentId: input.id }, "admin.learn.errors.kindFixed");
      }
      const changed =
        JSON.stringify(existing.title) !== JSON.stringify(input.title) ||
        JSON.stringify(existing.summary ?? null) !== JSON.stringify(input.summary ?? null) ||
        JSON.stringify(existing.body) !== JSON.stringify(input.body) ||
        JSON.stringify(existing.citations) !== JSON.stringify(input.citations);
      const version = changed ? existing.version + 1 : existing.version;
      await db.$transaction([
        db.learnDocument.update({
          where: { id: input.id },
          data: { ...content, ...meta, version },
          select: { id: true },
        }),
        db.learnCitation.deleteMany({ where: { documentId: input.id } }),
        ...(citationRows.length > 0
          ? [db.learnCitation.createMany({ data: citationRows.map((row) => ({ ...row, documentId: input.id! })) })]
          : []),
      ]);
      await invalidateLearn();
      return { id: input.id, version };
    }

    const chapterOrder =
      input.kind === "CHAPTER"
        ? ((await db.learnDocument.aggregate({
            where: { bookId: input.bookId!, deletedAt: null },
            _max: { chapterOrder: true },
          }))._max.chapterOrder ?? 0) + 1
        : null;
    const created = await db.learnDocument.create({
      data: {
        ...content,
        ...meta,
        kind: input.kind,
        bookId: input.bookId,
        chapterOrder,
        createdById: actorId,
        ...(input.provenance
          ? { createdBy: "AI", modelVersion: input.provenance.modelVersion, promptVersion: input.provenance.promptVersion }
          : {}),
        kbCitations: citationRows.length > 0 ? { create: citationRows } : undefined,
      },
      select: { id: true, version: true },
    });
    await invalidateLearn();
    return created;
  }

  async function transitionDocument(id: string, to: LearnStatus, actorId: string): Promise<void> {
    transitionLearnInputSchema.parse({ entity: "DOCUMENT", id, to });
    const doc = await db.learnDocument.findFirst({
      where: { id, deletedAt: null },
      select: {
        status: true,
        publishedAt: true,
        kind: true,
        body: true,
        title: true,
        book: { select: { deletedAt: true } },
      },
    });
    if (!doc) throw new NotFoundError({ documentId: id });
    if (doc.status === to) return;
    if (to === "PUBLISHED") {
      const body = doc.body as { en?: string; nb?: string };
      const title = doc.title as { en?: string; nb?: string };
      if (!body.en?.trim() || !body.nb?.trim() || !title.en?.trim() || !title.nb?.trim()) {
        throw new ValidationError({ documentId: id }, "admin.learn.errors.publishIncomplete");
      }
      if (doc.kind === "CHAPTER" && (!doc.book || doc.book.deletedAt)) {
        throw new ValidationError({ documentId: id }, "admin.learn.errors.bookMissing");
      }
    }
    await db.learnDocument.update({
      where: { id },
      data: {
        status: to,
        updatedById: actorId,
        ...(to === "PUBLISHED" && !doc.publishedAt ? { publishedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    await invalidateLearn();
  }

  async function deleteDocument(id: string, actorId: string): Promise<void> {
    const doc = await db.learnDocument.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!doc) throw new NotFoundError({ documentId: id });
    await db.learnDocument.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById: actorId },
      select: { id: true },
    });
    await invalidateLearn();
  }

  return { getDocumentAdmin, upsertDocument, transitionDocument, deleteDocument };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
