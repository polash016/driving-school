import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/** Topic chips as links: the filter lives in the URL, so it survives a reload and the back button. */
export function TopicFilter({ topics, activeId }: { topics: Array<{ id: string; name: string; count: number }>; activeId?: string }) {
  const t = useTranslations("learn");
  const chip = (active: boolean) =>
    `inline-flex min-h-9 shrink-0 items-center rounded-full border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 ${
      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted"
    }`;
  return (
    <nav aria-label={t("filterTopic")} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
      <Link href="/learn" aria-current={!activeId ? "page" : undefined} className={chip(!activeId)}>
        {t("filterAll")}
      </Link>
      {topics.map((topic) => (
        <Link key={topic.id} href={`/learn?topic=${topic.id}`} aria-current={activeId === topic.id ? "page" : undefined} className={chip(activeId === topic.id)}>
          {topic.name} <span className="ml-1 text-xs opacity-70">{topic.count}</span>
        </Link>
      ))}
    </nav>
  );
}
