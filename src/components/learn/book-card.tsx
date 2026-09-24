import { useTranslations } from "next-intl";
import { BookOpenIcon } from "@phosphor-icons/react/dist/ssr";
import { Link } from "@/i18n/navigation";
import type { HubBookCard } from "@/server/contracts/learn";

/** A book cover in the hub's horizontal row: 2:3 cover, title, chapters read. */
export function BookCard({ book }: { book: HubBookCard }) {
  const t = useTranslations("learn");
  const pct = book.chapterCount === 0 ? 0 : Math.round((book.readChapters / book.chapterCount) * 100);
  return (
    <Link
      href={`/learn/books/${book.slug}`}
      className="glass-lift flex w-36 shrink-0 snap-start flex-col gap-2 rounded-[calc(var(--radius-base)+6px)] p-2.5 outline-none transition-transform duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none"
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[var(--radius-control)] bg-muted">
        {book.coverImageId ? (
          // eslint-disable-next-line @next/next/no-img-element -- app-served, private image route
          <img src={`/api/images/${book.coverImageId}`} alt={t("bookCover", { title: book.title })} loading="lazy" decoding="async" className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center" style={{ backgroundImage: "var(--gradient-hero)" }} aria-hidden>
            <BookOpenIcon weight="duotone" className="size-10 text-white/90" />
          </div>
        )}
        {book.readChapters > 0 ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
            <div className="h-full bg-[var(--status-success)]" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>
      <div className="space-y-0.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{book.title}</p>
        <p className="text-xs text-muted-foreground">
          {book.readChapters > 0
            ? t("chaptersRead", { read: book.readChapters, total: book.chapterCount })
            : t("chapters", { count: book.chapterCount })}
        </p>
      </div>
    </Link>
  );
}
