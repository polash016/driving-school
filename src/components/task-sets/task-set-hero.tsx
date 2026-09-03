import { CaretRightIcon, ExamIcon } from "@phosphor-icons/react/dist/ssr";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { StudentTaskSetBoard } from "@/server/contracts/task-sets";

/**
 * The homepage's primary action (spec-16).
 *
 * Task sets get the weight because they are the product loop — and because they are the only
 * entry point with a progress story to tell. "12 of 32 passed" is the sentence a student opens the
 * app to read; Practice and Sign test have nothing comparable to say and sit below as a pair.
 */
export async function TaskSetHero({
  board,
  paperSize,
  timeLimitSec,
}: {
  board: StudentTaskSetBoard;
  paperSize: number;
  timeLimitSec: number;
}) {
  const t = await getTranslations("taskSets");

  const percent =
    board.totalCount === 0
      ? 0
      : Math.round((board.passedCount / board.totalCount) * 100);

  return (
    <Link
      href="/task-sets"
      className="block rounded-[calc(var(--radius-base)+2px)] bg-primary p-4 text-primary-foreground shadow-[var(--shadow-card)] transition-transform duration-150 outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-14 shrink-0 place-items-center rounded-[var(--radius-base)] bg-white/15">
          <ExamIcon weight="fill" className="size-8" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-semibold tracking-tight">
            {t("heroTitle")}
          </span>
          <span className="block text-xs/relaxed opacity-85">
            {t("heroSubtitle", {
              count: paperSize,
              minutes: Math.round(timeLimitSec / 60),
            })}
          </span>
        </span>
        <CaretRightIcon
          className="size-[1.125rem] shrink-0 opacity-70"
          aria-hidden
        />
      </div>

      {board.totalCount > 0 ? (
        <>
          <span
            className="mt-3 block h-1.5 w-full overflow-hidden rounded-full bg-white/25"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("progress", {
              passed: board.passedCount,
              total: board.totalCount,
            })}
          >
            <span
              className="block h-full rounded-full bg-white transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="mt-2 flex justify-between text-xs opacity-90">
            <span>
              {t("progress", {
                passed: board.passedCount,
                total: board.totalCount,
              })}
            </span>
            {board.nextNumber !== null ? (
              <span>{t("nextUp", { number: board.nextNumber })}</span>
            ) : null}
          </span>
        </>
      ) : null}
    </Link>
  );
}
