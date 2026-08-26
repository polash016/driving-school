import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  ReviewQueue,
  type ReviewItem,
} from "@/components/admin/questions/review-queue";
import { contentSideFor, pickBilingualText } from "@/lib/i18n-content";
import { requireUser } from "@/server/auth/require-user";
import { getSecurityPolicy } from "@/server/services/auth/security-policy";
import { requiredApprovals } from "@/server/services/question-bank/transitions";
import { db } from "@/server/db";
import type { AppLocale } from "../../../../../../config/school.config";

/** Review queue, oldest first — served by MasterItem_status_createdAt_idx. */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ batch?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);
  const user = await requireUser("INSTRUCTOR");

  const [t, policy, rows] = await Promise.all([
    getTranslations("admin.review"),
    getSecurityPolicy(db),
    db.masterItem.findMany({
      where: {
        status: "IN_REVIEW",
        deletedAt: null,
        // Scope to one generated set when asked — "review the batch I just made" is how this is
        // actually used, and it keeps a reviewer from wandering into someone else's queue.
        ...(query.batch ? { batchId: query.batch } : {}),
        // A reviewer never sees a question they have already signed off, and never their own
        // work when they authored it — the queue only shows what they can actually decide.
        NOT: { approvals: { some: { approverId: user.id } } },
        OR: [{ createdById: { not: user.id } }, { createdBy: "AI" }],
      },
      select: {
        id: true,
        difficulty: true,
        content: true,
        correctOptionKey: true,
        legalCitations: true,
        version: true,
        createdBy: true,
        topic: { select: { name: true } },
        // Served by MasterItem_sourceImageId_idx via the relation.
        sourceImage: { select: { url: true } },
        batch: { select: { factsVerified: true } },
        _count: { select: { approvals: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
  ]);

  const items: ReviewItem[] = rows.map((row) => {
    const content = row.content as {
      en?: {
        stem?: string;
        options?: { key: string; text: string }[];
        explanation?: string;
      };
      nb?: {
        stem?: string;
        options?: { key: string; text: string }[];
        explanation?: string;
      };
    };
    // Admin chrome stays English/Norwegian; a reviewer reads the authored text.
    const side =
      content[contentSideFor(locale)] ?? content.en ?? content.nb ?? {};
    return {
      id: row.id,
      approvalsRecorded: row._count.approvals,
      approvalsRequired: requiredApprovals(
        row.createdBy,
        policy.aiApprovalsRequired,
      ),
      topicLabel: pickBilingualText(row.topic.name, locale as AppLocale),
      difficulty: row.difficulty,
      stem: side.stem ?? "",
      options: side.options ?? [],
      correctOptionKey: row.correctOptionKey ?? "",
      explanation: side.explanation ?? "",
      citations: (row.legalCitations ?? []) as {
        sourceCode: string;
        ref: string;
      }[],
      imageUrl: row.sourceImage?.url ?? null,
      // A question with no batch was written by a person, so there are no machine-read facts to
      // doubt; only a batch that generated from an unconfirmed picture is flagged.
      factsVerified: row.batch ? row.batch.factsVerified : true,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="text-sm/relaxed text-muted-foreground">
          {query.batch ? t("subtitleOneSet") : t("subtitle")}
        </p>
      </header>
      <ReviewQueue items={items} />
    </div>
  );
}
