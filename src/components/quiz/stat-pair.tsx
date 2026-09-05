import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";

/** Shown when nothing countable has been graded yet. */
const EMPTY = "—";

/**
 * The two headline numbers (spec-09, delivered in spec-18): how often this student passes, and how
 * many sets they have cleared.
 *
 * Deliberately two, not four. The reference shows two, and a streak and a readiness gauge alongside
 * them would push the topic breakdown — the part a student can actually act on — below the fold.
 * Those live on the statistics page (spec-09 amendment 2026-09-03).
 *
 * A student with no graded test yet gets an em dash rather than "0%", which would read as a verdict
 * on someone who has not been assessed.
 */
export async function StatPair({
  passRate,
  passedCount,
}: {
  /** 0–100, or null when nothing countable has been graded yet. */
  passRate: number | null;
  passedCount: number;
}) {
  const t = await getTranslations("home");

  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat
        value={passRate === null ? EMPTY : `${passRate}%`}
        label={t("statPassRate")}
      />
      <Stat value={String(passedCount)} label={t("statSetsPassed")} />
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <Card className="rounded-[calc(var(--radius-base)+6px)] [--card-spacing:--spacing(3)]">
      <CardContent className="text-center">
        {value === EMPTY ? (
          // A gradient em-dash reads as a broken number. Nothing to show is a muted state.
          <p className="text-[1.45rem] font-bold tracking-[-0.03em] text-muted-foreground">
            {EMPTY}
          </p>
        ) : (
          <p
            className="bg-clip-text text-[1.45rem] font-bold tracking-[-0.03em] text-transparent tabular-nums"
            style={{ backgroundImage: "var(--gradient-stat)" }}
          >
            {value}
          </p>
        )}
        <p className="mt-0.5 text-[0.625rem] font-medium tracking-[0.06em] text-muted-foreground uppercase">
          {label}
        </p>
      </CardContent>
    </Card>
  );
}
