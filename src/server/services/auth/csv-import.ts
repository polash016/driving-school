import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { parseCsvRecords } from "@/lib/csv";
import { ValidationError } from "@/lib/errors";
import { AUDIT, auditLog } from "@/server/audit";
import {
  csvImportResultSchema,
  importStudentsInputSchema,
  type CsvImportResult,
} from "@/server/contracts/auth";
import { sendMail } from "@/server/email/mailer";
import { inviteEmail } from "@/server/email/templates";
import type { AppLocale } from "../../../../config/school.config";
import { schoolConfig } from "../../../../config/school.config";
import { normalizeEmail } from "./crypto";
import { createInvite, inviteUrl } from "./invites";

/**
 * Bulk student onboarding (spec-03): a CSV of students becomes one bound single-use invite
 * each, emailed to the address in the row. No account is created until the student registers
 * and sets their own password — the school never handles student passwords.
 *
 * Expected header: email,firstName,lastName[,groupName] (case/spacing insensitive; the
 * semicolon dialect Norwegian Excel produces is detected automatically).
 */

const rowSchema = z.object({
  email: z.email(),
  firstname: z.string().min(1).optional(),
  lastname: z.string().min(1).optional(),
  groupname: z.string().optional(),
});

export async function importStudentsCsv(
  db: PrismaClient,
  actorId: string,
  rawInput: unknown,
  options: { locale?: AppLocale; now?: Date } = {},
): Promise<CsvImportResult> {
  const input = importStudentsInputSchema.parse(rawInput);
  const locale = options.locale ?? schoolConfig.locales.default;
  const records = parseCsvRecords(input.csv);

  if (records.length === 0) {
    throw new ValidationError({ reason: "empty csv" }, "admin.invites.errors.csvEmpty");
  }
  if (!("email" in records[0])) {
    throw new ValidationError({ reason: "no email column" }, "admin.invites.errors.csvNoEmail");
  }

  const rows: CsvImportResult["rows"] = [];
  const seen = new Set<string>();
  let invited = 0;

  for (const record of records) {
    const parsed = rowSchema.safeParse(record);
    if (!parsed.success) {
      rows.push({
        email: record.email ?? "",
        status: "invalid",
        messageKey: "admin.invites.rows.invalid",
      });
      continue;
    }

    const email = normalizeEmail(parsed.data.email);
    if (seen.has(email)) {
      rows.push({ email, status: "exists", messageKey: "admin.invites.rows.duplicate" });
      continue;
    }
    seen.add(email);

    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      rows.push({ email, status: "exists", messageKey: "admin.invites.rows.exists" });
      continue;
    }

    const invite = await createInvite(
      db,
      actorId,
      {
        role: "STUDENT",
        groupId: input.groupId,
        maxUses: 1,
        expiresInDays: input.expiresInDays,
      },
      { email, locale, now: options.now },
    );
    await sendMail(await inviteEmail(locale, email, inviteUrl(invite.token, locale)));
    rows.push({ email, status: "invited", messageKey: "admin.invites.rows.invited" });
    invited++;
  }

  const result = csvImportResultSchema.parse({
    invited,
    skipped: rows.length - invited,
    rows,
  });

  await auditLog({
    actorId,
    action: AUDIT.studentsImported,
    entityType: "InviteLink",
    meta: { invited: result.invited, skipped: result.skipped },
  });
  return result;
}
