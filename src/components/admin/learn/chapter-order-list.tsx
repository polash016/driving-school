"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { toast } from "sonner";
import { reorderChaptersAction } from "@/app/[locale]/(admin)/admin/learn/actions";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { pickBilingualText } from "@/lib/i18n-content";
import type { ActionResult } from "@/server/contracts/common";
import type { AdminBook } from "@/server/contracts/learn";
import { StatusBadge } from "./status-badge";

/**
 * Chapter ordering with Move up / Move down (spec-23). Buttons, not drag: keyboard-accessible by
 * construction, and each move is announced. One "Save order" submit rewrites the whole list.
 */
export function ChapterOrderList({ book, locale }: { book: AdminBook; locale: string }) {
  const t = useTranslations("admin.learn.book");
  const tLearn = useTranslations("admin.learn");
  const tErrors = useTranslations();
  const [order, setOrder] = useState(book.chapters);
  const [announcement, setAnnouncement] = useState("");
  const [, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    async (previous, formData) => {
      const result = await reorderChaptersAction(previous, formData);
      if (result.ok) toast.success(t("orderSaved"));
      else toast.error(tErrors(result.messageKey));
      return result;
    },
    undefined,
  );

  const dirty = order.map((c) => c.id).join() !== book.chapters.map((c) => c.id).join();

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setOrder(next);
    setAnnouncement(t("moved", { title: pickBilingualText(moved!.title, locale), position: target + 1 }));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("chapters")}</h2>
        <Button asChild size="sm" variant="outline">
          <Link href={{ pathname: "/admin/learn/articles/new", query: { bookId: book.id, kind: "CHAPTER" } }}>
            {tLearn("newChapter")}
          </Link>
        </Button>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {order.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("chaptersEmpty")}</p>
      ) : (
        <ol className="divide-y divide-border rounded-[var(--radius-base)] border border-border">
          {order.map((chapter, index) => {
            const title = pickBilingualText(chapter.title, locale);
            return (
              <li key={chapter.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-6 text-sm tabular-nums text-muted-foreground">{t("position", { position: index + 1 })}</span>
                <Link
                  href={`/admin/learn/articles/${chapter.id}`}
                  className="flex-1 truncate font-medium underline-offset-4 hover:underline"
                >
                  {title}
                </Link>
                <StatusBadge status={chapter.status} />
                <div className="flex gap-1">
                  <Button type="button" size="icon" variant="ghost" aria-label={t("moveUp", { title })} disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={t("moveDown", { title })} disabled={index === order.length - 1} onClick={() => move(index, 1)}>
                    ↓
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {order.length > 1 ? (
        <form action={formAction}>
          <input type="hidden" name="payload" value={JSON.stringify({ bookId: book.id, documentIds: order.map((c) => c.id) })} />
          <Button type="submit" size="sm" disabled={!dirty || pending} aria-busy={pending}>
            {t("saveOrder")}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
