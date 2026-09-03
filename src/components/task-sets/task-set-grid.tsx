"use client";

import { useTranslations } from "next-intl";
import { useCallback, useRef, useState, useTransition } from "react";
import { taskSetAttemptsAction } from "@/app/[locale]/(student)/quiz/actions";
import { Card, CardContent } from "@/components/ui/card";
import type {
  StudentTaskSet,
  StudentTaskSetBoard,
  TaskSetAttempt,
} from "@/server/contracts/task-sets";
import type { AppLocale } from "../../../config/school.config";
import { TaskSetSheet } from "./task-set-sheet";
import { TaskSetTile } from "./task-set-tile";

/**
 * The numbered grid (spec-16), three across at the 390px design target.
 *
 * Attempt history is fetched when a set is opened rather than shipped with the page: 32 sets ×
 * 10 attempts would be a large payload for a list almost none of which is ever read, and the grid
 * itself needs only the summary already on each tile.
 */
export function TaskSetGrid({
  board,
  locale,
}: {
  board: StudentTaskSetBoard;
  locale: AppLocale;
}) {
  const t = useTranslations("taskSets");
  const [selected, setSelected] = useState<StudentTaskSet | null>(null);
  // Open state is tracked SEPARATELY from the selection on purpose: clearing `selected` on close
  // would unmount the sheet mid-exit, and Radix would never get to restore focus to the tile that
  // opened it — leaving a keyboard user stranded on <body>.
  const [isOpen, setIsOpen] = useState(false);
  const [attempts, setAttempts] = useState<TaskSetAttempt[]>([]);
  const [, startTransition] = useTransition();
  /**
   * Tiles by set id, so focus can be put back explicitly when the sheet closes.
   *
   * Radix restores focus to the node that opened the dialog, but the server action that loads the
   * attempt history re-renders this subtree, and the node Radix memorised is detached by then —
   * focus would land on <body> and a keyboard user would be stranded at the top of the page. Owning
   * the restore ourselves is immune to that.
   */
  const tiles = useRef(new Map<string, HTMLButtonElement | null>());

  const open = useCallback((set: StudentTaskSet) => {
    setSelected(set);
    setIsOpen(true);
    // Show the sheet immediately with what the tile already knows; the history fills in.
    setAttempts([]);
    startTransition(async () => {
      const result = await taskSetAttemptsAction(set.id);
      if (result.ok) setAttempts(result.data);
    });
  }, []);

  if (board.sets.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 text-center">
          <p className="font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="text-sm/relaxed text-muted-foreground">
            {t("emptyBody")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-2.5">
        {board.sets.map((set) => (
          <TaskSetTile
            key={set.id}
            set={set}
            buttonRef={(node) => {
              tiles.current.set(set.id, node);
            }}
            onOpen={() => open(set)}
          />
        ))}
      </div>

      <TaskSetSheet
        set={selected}
        attempts={attempts}
        locale={locale}
        open={isOpen}
        onOpenChange={(next) => {
          setIsOpen(next);
          if (!next && selected) {
            const tile = tiles.current.get(selected.id);
            // After Radix has finished its own (failed) restore, so we win the race.
            requestAnimationFrame(() => tile?.focus());
          }
        }}
      />
    </>
  );
}
