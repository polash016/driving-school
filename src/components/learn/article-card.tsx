import { useTranslations } from "next-intl";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/ssr";
import { Link } from "@/i18n/navigation";
import type { HubArticleCard } from "@/server/contracts/learn";

export function ArticleCard({ article }: { article: HubArticleCard }) {
  const t = useTranslations("learn");
  return (
    <Link
      href={`/learn/read/${article.slug}`}
      className="glass-lift flex gap-3 rounded-[calc(var(--radius-base)+6px)] p-3 outline-none transition-transform duration-150 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none"
    >
      {article.heroImageId ? (
        // eslint-disable-next-line @next/next/no-img-element -- app-served, private image route
        <img src={`/api/images/${article.heroImageId}`} alt="" loading="lazy" decoding="async" className="size-20 shrink-0 rounded-[var(--radius-control)] bg-muted object-cover" />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-[15px] font-semibold leading-snug text-foreground">{article.title}</p>
          {article.readAt ? <CheckCircleIcon weight="fill" className="mt-0.5 size-4 shrink-0 text-[var(--status-success)]" aria-label={t("markedRead")} /> : null}
        </div>
        {article.summary ? <p className="line-clamp-2 text-sm text-muted-foreground">{article.summary}</p> : null}
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-0.5">{article.topicName}</span>
          <span className="py-0.5">{t("readMinutes", { minutes: article.readMinutes })}</span>
        </p>
      </div>
    </Link>
  );
}
