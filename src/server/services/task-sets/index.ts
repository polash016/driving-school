import { db } from "@/server/db";
import { createTaskSetService } from "./service";

/**
 * Composition root for task sets (spec-16), mirroring services/assessment/index.ts: the service
 * itself takes its Prisma client as an argument so tests can hand it the test database.
 */
export const taskSetService = createTaskSetService(db);

export { createTaskSetService, type TaskSetService } from "./service";
export { nextProgress, recordTaskSetRun } from "./progress";
export { partitionBank, type PartitionItem } from "./partition";
