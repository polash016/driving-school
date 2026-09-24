import { useTranslations } from "next-intl";
import type { LearnStatus } from "@/server/contracts/learn";

const TONE: Record<LearnStatus, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  PUBLISHED: "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]",
  ARCHIVED: "bg-[var(--status-warning-soft)] text-[var(--status-warning-strong)]",
};

export function StatusBadge({ status }: { status: LearnStatus }) {
  const t = useTranslations("admin.learn.status");
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}
    >
      {t(status)}
    </span>
  );
}
