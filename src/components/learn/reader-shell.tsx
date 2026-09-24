"use client";

import { CaretLeftIcon, CaretRightIcon, CheckCircleIcon, ListIcon } from "@phosphor-icons/react/dist/ssr";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { recordReadingProgressAction } from "@/app/[locale]/(student)/learn/read/[slug]/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Link } from "@/i18n/navigation";
import type { ReaderDocument } from "@/server/contracts/learn";

const MILESTONES = [25, 50, 75, 95];
const QUEUE_KEY = "tp:learn:progress-queue";

/**
 * Everything interactive around the rendered chapter (spec-23): the sticky strip with the
 * chapter sheet, the 2 px progress bar (transform only, on rAF), progress saved at milestones
 * and when the tab hides, an offline queue in sessionStorage, and an optimistic Mark-as-read.
 * The text itself is rendered by the server and passed in as children.
 */
export function ReaderShell({
  doc,
  chapters,
  children,
}: {
  doc: ReaderDocument;
  chapters: Array<{ slug: string; title: string; chapterOrder: number; readAt: boolean }>;
  children: React.ReactNode;
}) {
  const t = useTranslations("learn");
  const [readAt, setReadAt] = useState<string | null>(doc.progress.readAt ? doc.progress.readAt.toISOString() : null);
  const [optimisticRead, markOptimistic] = useOptimistic(Boolean(readAt), (_current, next: boolean) => next);
  const [pending, startTransition] = useTransition();
  const [offline, setOffline] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const furthest = useRef(doc.progress.positionPct);
  const sent = useRef(new Set(MILESTONES.filter((m) => m <= doc.progress.positionPct)));

  const save = useCallback(
    async (positionPct: number, markRead: boolean) => {
      const payload = { documentId: doc.id, positionPct, markRead };
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        try {
          sessionStorage.setItem(QUEUE_KEY, JSON.stringify(payload));
        } catch {
          /* private mode: nothing to queue into; the next visit re-saves */
        }
        setOffline(true);
        return null;
      }
      const result = await recordReadingProgressAction(payload);
      if (!result.ok) {
        toast.error(t("progressSaveFailed"));
        return null;
      }
      if (result.data.readAt) setReadAt(result.data.readAt);
      return result.data;
    },
    [doc.id, t],
  );

  // Scroll → progress bar (transform only) + milestone saves.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        const pct = max <= 0 ? 100 : Math.min(100, Math.round((window.scrollY / max) * 100));
        if (barRef.current) barRef.current.style.transform = `scaleX(${pct / 100})`;
        if (pct > furthest.current) furthest.current = pct;
        for (const milestone of MILESTONES) {
          if (pct >= milestone && !sent.current.has(milestone)) {
            sent.current.add(milestone);
            void save(pct, false);
          }
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const onHide = () => {
      if (document.visibilityState === "hidden" && furthest.current > 0) void save(furthest.current, false);
    };
    document.addEventListener("visibilitychange", onHide);
    const onOnline = () => {
      setOffline(false);
      try {
        const queued = sessionStorage.getItem(QUEUE_KEY);
        if (queued) {
          sessionStorage.removeItem(QUEUE_KEY);
          const payload = JSON.parse(queued) as { documentId: string; positionPct: number; markRead: boolean };
          if (payload.documentId === doc.id) void save(payload.positionPct, payload.markRead);
        }
      } catch {
        /* nothing queued */
      }
    };
    window.addEventListener("online", onOnline);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("online", onOnline);
    };
  }, [doc.id, save]);

  function markRead() {
    startTransition(async () => {
      markOptimistic(true);
      const result = await save(100, true);
      if (!result?.readAt && !offline) markOptimistic(false);
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-10">
      <div className="sticky top-14 z-20 -mx-4 bg-background/90 backdrop-blur-sm">
        <div className="h-0.5 w-full bg-muted">
          <div ref={barRef} className="h-full origin-left bg-primary transition-transform duration-150 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${doc.progress.positionPct / 100})` }} aria-hidden />
        </div>
        <div className="flex min-h-11 items-center justify-between gap-2 px-4 text-sm">
          <Link href={doc.book ? `/learn/books/${doc.book.slug}` : "/learn"} className="inline-flex min-h-11 items-center gap-1 text-muted-foreground underline-offset-4 hover:underline">
            <CaretLeftIcon className="size-4" aria-hidden />
            {doc.book ? t("backToBook") : t("backToHub")}
          </Link>
          {doc.book ? (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="min-h-11 gap-1.5">
                  <ListIcon className="size-4" aria-hidden />
                  {t("chapterOf", { n: doc.book.chapterOrder, total: doc.book.chapterCount })}
                </Button>
              </SheetTrigger>
              <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-[calc(var(--radius-base)+6px)]">
                <SheetHeader>
                  <SheetTitle>{doc.book.title}</SheetTitle>
                  <SheetDescription>{t("chapterList")}</SheetDescription>
                </SheetHeader>
                <ol className="divide-y divide-border">
                  {chapters.map((chapter) => (
                    <li key={chapter.slug}>
                      <Link
                        href={`/learn/read/${chapter.slug}`}
                        aria-current={chapter.slug === doc.slug ? "page" : undefined}
                        className={`flex min-h-12 items-center gap-3 px-1 text-sm ${chapter.slug === doc.slug ? "font-semibold text-foreground" : "text-foreground"}`}
                      >
                        <span className="w-6 tabular-nums text-muted-foreground">{chapter.chapterOrder}</span>
                        <span className="flex-1">{chapter.title}</span>
                        {chapter.readAt ? <CheckCircleIcon weight="fill" className="size-4 text-[var(--status-success)]" aria-label={t("markedRead")} /> : null}
                      </Link>
                    </li>
                  ))}
                </ol>
              </SheetContent>
            </Sheet>
          ) : null}
        </div>
      </div>

      {offline ? (
        <p role="status" className="mt-3 rounded-[var(--radius-control)] bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("offlineNote")}
        </p>
      ) : null}

      {children}

      <div className="mt-8 space-y-3">
        <Button type="button" variant={optimisticRead ? "secondary" : "default"} size="lg" className="w-full gap-2" onClick={markRead} disabled={optimisticRead || pending} aria-pressed={optimisticRead}>
          <CheckCircleIcon weight={optimisticRead ? "fill" : "regular"} className="size-5" aria-hidden />
          {optimisticRead ? t("markedRead") : t("markRead")}
        </Button>
        {doc.book ? (
          <nav aria-label={t("chapterList")} className="grid grid-cols-2 gap-2">
            {doc.prev ? (
              <Button asChild variant="outline" size="lg" className="justify-start gap-1 truncate">
                <Link href={`/learn/read/${doc.prev.slug}`}>
                  <CaretLeftIcon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{t("prev")}</span>
                </Link>
              </Button>
            ) : (
              <span />
            )}
            {doc.next ? (
              <Button asChild size="lg" className="justify-end gap-1 truncate">
                <Link href={`/learn/read/${doc.next.slug}`}>
                  <span className="truncate">{t("next")}</span>
                  <CaretRightIcon className="size-4 shrink-0" aria-hidden />
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
