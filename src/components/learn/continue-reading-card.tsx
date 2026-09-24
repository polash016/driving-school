import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { ContinueReading } from "@/server/contracts/learn";

/** The chapter a student left half-read — on the home page, under the tiles. */
export function ContinueReadingCard({ item }: { item: ContinueReading }) {
  const t = useTranslations("home");
  return (
    <Card className="border-primary/30 bg-accent/40">
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("continueReadingTitle")}</p>
            <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
            {item.bookTitle ? <p className="truncate text-xs text-muted-foreground">{t("continueReadingIn", { book: item.bookTitle })}</p> : null}
          </div>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{item.positionPct}%</p>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={item.positionPct} aria-valuemin={0} aria-valuemax={100} aria-label={t("continueReadingProgress", { percent: item.positionPct, minutes: item.readMinutesLeft })}>
          <div className="h-full rounded-full bg-primary" style={{ width: `${item.positionPct}%` }} />
        </div>
        <Button asChild size="lg" className="w-full">
          <Link href={`/learn/read/${item.slug}`}>{t("continueReading")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
