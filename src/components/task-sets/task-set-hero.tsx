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
      className="relative block overflow-hidden rounded-[calc(var(--radius-base)+6px)] p-4 text-white shadow-[var(--shadow-hero)] transition-transform duration-150 outline-none active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:active:scale-100"
      style={{ backgroundImage: "var(--gradient-hero)" }}
    >
      {/* A single STATIC specular sweep — never animated (spec-18 §4). It is what separates a
          glossy card from a flat coloured one, and it costs one paint. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-[-10%] top-[-40%] h-[150%]"
        style={{ backgroundImage: "var(--gradient-sheen)" }}
      />
      {/* The specular top edge, matching every glass surface on the page. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/35"
      />
      <div className="relative flex items-center gap-3">
        <span className="grid size-[3.25rem] shrink-0 place-items-center rounded-[1.05rem] border border-white/25 bg-white/[0.18] shadow-[inset_0_1px_0_oklch(1_0_0/0.4)]">
          <ExamIcon weight="fill" className="size-8" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[1.15rem] font-bold tracking-[-0.02em]">
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
            className="relative mt-3.5 block h-[7px] w-full overflow-hidden rounded-full bg-white/[0.22] shadow-[inset_0_1px_2px_oklch(0_0_0/0.14)]"
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
              className="block h-full rounded-full bg-gradient-to-r from-white/75 to-white shadow-[0_0_10px_oklch(1_0_0/0.7)] transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="relative mt-2 flex justify-between text-xs opacity-90">
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
