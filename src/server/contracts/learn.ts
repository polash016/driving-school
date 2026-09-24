import { z } from "zod";
import {
  bilingualTextSchema,
  idSchema,
  paginationInputSchema,
  paginatedSchema,
} from "./common";
import { legalCitationSchema } from "./models";

/**
 * Learn section contracts (spec-23): books, documents (articles and chapters), reading progress
 * and AI drafting. Every server action and service boundary parses with these — input AND output.
 */

export const learnStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export type LearnStatus = z.infer<typeof learnStatusSchema>;

export const learnDocKindSchema = z.enum(["ARTICLE", "CHAPTER"]);
export type LearnDocKind = z.infer<typeof learnDocKindSchema>;

export const learnEntitySchema = z.enum(["BOOK", "DOCUMENT"]);

/** URL slug: lowercase, digits, single hyphens. Shared by books and documents. */
export const learnSlugSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "admin.learn.errors.slug");

/** ~9 000 words per side — a chapter, not a book. */
export const MARKDOWN_MAX = 60_000;
export const TITLE_MAX = 120;
export const SUMMARY_MAX = 300;
export const CITATIONS_MAX = 20;

const markdownSideSchema = z.string().max(MARKDOWN_MAX);
/** A draft may still have an empty side; publishing re-validates with both sides required. */
export const draftBilingualMarkdownSchema = z.object({
  en: markdownSideSchema,
  nb: markdownSideSchema,
});
export const bilingualMarkdownSchema = z.object({
  en: markdownSideSchema.min(1),
  nb: markdownSideSchema.min(1),
});
export const draftBilingualShortSchema = z.object({
  en: z.string().max(SUMMARY_MAX),
  nb: z.string().max(SUMMARY_MAX),
});
export const learnTitleSchema = z.object({
  en: z.string().min(1).max(TITLE_MAX),
  nb: z.string().min(1).max(TITLE_MAX),
});

// ───────────────────────────────────────────────────────────── admin inputs ──

export const upsertBookInputSchema = z
  .object({
    id: idSchema.optional(),
    slug: learnSlugSchema,
    title: learnTitleSchema,
    description: draftBilingualShortSchema.optional(),
    coverImageId: idSchema.nullable().default(null),
    licenseClassId: idSchema.nullable().default(null),
    sortOrder: z.int().min(0).max(10_000).default(0),
  })
  .strict();
export type UpsertBookInput = z.infer<typeof upsertBookInputSchema>;

export const reorderChaptersInputSchema = z
  .object({
    bookId: idSchema,
    /** Every live chapter of the book, in the new order — the service refuses a partial list. */
    documentIds: z.array(idSchema).min(1).max(200),
  })
  .strict();
export type ReorderChaptersInput = z.infer<typeof reorderChaptersInputSchema>;

export const upsertDocumentInputSchema = z
  .object({
    id: idSchema.optional(),
    kind: learnDocKindSchema,
    bookId: idSchema.nullable().default(null),
    slug: learnSlugSchema,
    topicId: idSchema,
    licenseClassId: idSchema.nullable().default(null),
    title: learnTitleSchema,
    summary: draftBilingualShortSchema.optional(),
    body: draftBilingualMarkdownSchema,
    heroImageId: idSchema.nullable().default(null),
    citations: z.array(legalCitationSchema).max(CITATIONS_MAX).default([]),
    /** Only honoured on create: a saved AI draft records where it came from. */
    provenance: z
      .object({
        createdBy: z.literal("AI"),
        modelVersion: z.string().min(1),
        promptVersion: z.string().min(1),
      })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "CHAPTER" && !value.bookId) {
      ctx.addIssue({
        code: "custom",
        path: ["bookId"],
        message: "admin.learn.errors.chapterNeedsBook",
      });
    }
    if (value.kind === "ARTICLE" && value.bookId) {
      ctx.addIssue({
        code: "custom",
        path: ["bookId"],
        message: "admin.learn.errors.articleHasBook",
      });
    }
  });
export type UpsertDocumentInput = z.infer<typeof upsertDocumentInputSchema>;

export const transitionLearnInputSchema = z
  .object({
    entity: learnEntitySchema,
    id: idSchema,
    to: learnStatusSchema,
  })
  .strict();
export type TransitionLearnInput = z.infer<typeof transitionLearnInputSchema>;

export const deleteLearnInputSchema = z
  .object({ entity: learnEntitySchema, id: idSchema })
  .strict();

export const listLearnAdminInputSchema = paginationInputSchema
  .extend({
    tab: z.enum(["BOOKS", "ARTICLES", "CHAPTERS"]).default("ARTICLES"),
    status: learnStatusSchema.optional(),
    topicId: idSchema.optional(),
    search: z.string().max(80).optional(),
  })
  .strict();
export type ListLearnAdminInput = z.infer<typeof listLearnAdminInputSchema>;

export const draftDocumentInputSchema = z
  .object({
    topicId: idSchema,
    kind: learnDocKindSchema,
    bookId: idSchema.nullable().default(null),
    sourceCodes: z.array(z.string().min(1).max(40)).max(4).default([]),
    sectionRef: z.string().max(40).optional(),
    brief: z.string().max(500).optional(),
    targetWords: z.int().min(250).max(1500),
  })
  .strict();
export type DraftDocumentInput = z.infer<typeof draftDocumentInputSchema>;

// ─────────────────────────────────────────────────────────── student inputs ──

export const hubQuerySchema = paginationInputSchema
  .extend({ topicId: idSchema.optional() })
  .strict();
export type HubQuery = z.infer<typeof hubQuerySchema>;

export const readingProgressInputSchema = z
  .object({
    documentId: idSchema,
    positionPct: z.int().min(0).max(100),
    markRead: z.boolean().default(false),
  })
  .strict();
export type ReadingProgressInput = z.infer<typeof readingProgressInputSchema>;

// ───────────────────────────────────────────────────────────────── outputs ──

export const adminLearnRowSchema = z.object({
  id: idSchema,
  entity: learnEntitySchema,
  kind: learnDocKindSchema.nullable(),
  slug: z.string(),
  title: bilingualTextSchema,
  status: learnStatusSchema,
  topicName: z.string().nullable(),
  bookTitle: z.string().nullable(),
  chapterCount: z.int().nullable(),
  wordCountEn: z.int().nullable(),
  updatedAt: z.date(),
  publishedAt: z.date().nullable(),
});
export type AdminLearnRow = z.infer<typeof adminLearnRowSchema>;
export const adminLearnPageSchema = paginatedSchema(adminLearnRowSchema);
export type AdminLearnPage = z.infer<typeof adminLearnPageSchema>;

export const adminChapterRowSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: bilingualTextSchema,
  status: learnStatusSchema,
  chapterOrder: z.int().nullable(),
  wordCountEn: z.int(),
});

export const adminBookSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: bilingualTextSchema,
  description: draftBilingualShortSchema.nullable(),
  coverImageId: idSchema.nullable(),
  licenseClassId: idSchema.nullable(),
  status: learnStatusSchema,
  sortOrder: z.int(),
  publishedAt: z.date().nullable(),
  chapters: z.array(adminChapterRowSchema),
});
export type AdminBook = z.infer<typeof adminBookSchema>;

export const adminDocumentSchema = z.object({
  id: idSchema,
  kind: learnDocKindSchema,
  bookId: idSchema.nullable(),
  book: z.object({ id: idSchema, title: bilingualTextSchema, status: learnStatusSchema }).nullable(),
  chapterOrder: z.int().nullable(),
  slug: z.string(),
  topicId: idSchema,
  licenseClassId: idSchema.nullable(),
  title: bilingualTextSchema,
  summary: draftBilingualShortSchema.nullable(),
  body: draftBilingualMarkdownSchema,
  heroImageId: idSchema.nullable(),
  citations: z.array(legalCitationSchema),
  unresolvedCitations: z.array(legalCitationSchema),
  status: learnStatusSchema,
  publishedAt: z.date().nullable(),
  version: z.int(),
  wordCount: z.object({ en: z.int(), nb: z.int() }),
  createdBy: z.enum(["AI", "HUMAN"]),
});
export type AdminDocument = z.infer<typeof adminDocumentSchema>;

export const learnCitationViewSchema = z.object({
  sourceCode: z.string(),
  sourceName: z.string(),
  ref: z.string(),
});

export const hubBookCardSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  coverImageId: idSchema.nullable(),
  chapterCount: z.int(),
  readChapters: z.int(),
  licenseClassCode: z.string().nullable(),
  inLocale: z.boolean(),
});
export type HubBookCard = z.infer<typeof hubBookCardSchema>;

export const hubArticleCardSchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  topicName: z.string(),
  readMinutes: z.int(),
  heroImageId: idSchema.nullable(),
  readAt: z.date().nullable(),
  inLocale: z.boolean(),
});
export type HubArticleCard = z.infer<typeof hubArticleCardSchema>;

export const continueReadingSchema = z.object({
  slug: z.string(),
  title: z.string(),
  bookTitle: z.string().nullable(),
  positionPct: z.int(),
  readMinutesLeft: z.int(),
});
export type ContinueReading = z.infer<typeof continueReadingSchema>;

export const hubSchema = z.object({
  books: z.array(hubBookCardSchema),
  articles: paginatedSchema(hubArticleCardSchema),
  topics: z.array(z.object({ id: idSchema, name: z.string(), count: z.int() })),
  continue: continueReadingSchema.nullable(),
});
export type Hub = z.infer<typeof hubSchema>;

export const bookPageSchema = z.object({
  book: z.object({
    id: idSchema,
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    coverImageId: idSchema.nullable(),
    inLocale: z.boolean(),
  }),
  chapters: z.array(
    z.object({
      id: idSchema,
      slug: z.string(),
      title: z.string(),
      chapterOrder: z.int(),
      readMinutes: z.int(),
      readAt: z.date().nullable(),
      positionPct: z.int(),
    }),
  ),
  readCount: z.int(),
  nextUnreadSlug: z.string().nullable(),
});
export type BookPage = z.infer<typeof bookPageSchema>;

export const readerDocumentSchema = z.object({
  id: idSchema,
  slug: z.string(),
  kind: learnDocKindSchema,
  version: z.int(),
  title: z.string(),
  summary: z.string().nullable(),
  bodyMarkdown: z.string(),
  /** The locale the text is actually in: the requested one, or the fallback when not translated yet. */
  servedLocale: z.string(),
  inLocale: z.boolean(),
  heroImageId: idSchema.nullable(),
  readMinutes: z.int(),
  topic: z.object({ slug: z.string(), name: z.string() }),
  citations: z.array(learnCitationViewSchema),
  book: z
    .object({
      slug: z.string(),
      title: z.string(),
      chapterOrder: z.int(),
      chapterCount: z.int(),
    })
    .nullable(),
  prev: z.object({ slug: z.string(), title: z.string() }).nullable(),
  next: z.object({ slug: z.string(), title: z.string() }).nullable(),
  progress: z.object({
    positionPct: z.int(),
    readAt: z.date().nullable(),
    updatedSinceRead: z.boolean(),
  }),
});
export type ReaderDocument = z.infer<typeof readerDocumentSchema>;

export const draftResultSchema = z.object({
  title: learnTitleSchema,
  summary: draftBilingualShortSchema,
  body: bilingualMarkdownSchema,
  citations: z.array(legalCitationSchema),
  unresolvedCitations: z.array(legalCitationSchema),
  excerptCount: z.int(),
  modelVersion: z.string(),
  promptVersion: z.string(),
  /** i18n keys under admin.learn.ai.warnings.* */
  warnings: z.array(z.string()),
});
export type DraftResult = z.infer<typeof draftResultSchema>;
