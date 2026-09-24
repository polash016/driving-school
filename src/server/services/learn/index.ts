import type { PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { createBookService } from "./books";
import { createDocumentService } from "./documents";

/**
 * Composition root for the Learn section (spec-23), mirroring services/task-sets/index.ts: the
 * services take their Prisma client as an argument so tests can hand them the test database.
 */
export function createLearnService(client: PrismaClient) {
  return { ...createBookService(client), ...createDocumentService(client) };
}

export type LearnService = ReturnType<typeof createLearnService>;
export const learnService = createLearnService(db);

export { createBookService, type BookService } from "./books";
export { createDocumentService, type DocumentService } from "./documents";
export { invalidateLearn, learnVersion } from "./cache";
