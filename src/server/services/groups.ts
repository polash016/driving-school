import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { idSchema } from "@/server/contracts/common";

/**
 * Student groups — minimal read surface for the spec-03 invite form.
 * The full group management screens are spec-11.
 */
export const groupOptionSchema = z.object({ id: idSchema, name: z.string() }).strict();
export type GroupOption = z.infer<typeof groupOptionSchema>;

/** Alphabetical, non-deleted groups. Small table; the admin form needs the full list. */
export async function listGroupOptions(db: PrismaClient): Promise<GroupOption[]> {
  const groups = await db.studentGroup.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 200,
  });
  return groups.map((group) => groupOptionSchema.parse(group));
}
