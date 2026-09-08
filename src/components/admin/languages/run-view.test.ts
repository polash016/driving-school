import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canStartRuns,
  isRunLive,
  runControls,
  shouldPollSample,
} from "./run-view";
import type { RunDetail } from "@/server/services/i18n/run-control";

/**
 * The state rules behind the languages screens (spec-19).
 *
 * There is no DOM in this suite, and that is the point: every rule here was a bug in markup that
 * reading the markup did not reveal — controls that vanished exactly when they were needed, a poll
 * with no exit, a button whose action refuses the role the page admits, a live region that read a
 * whole card aloud every three seconds. As functions they are checkable; as JSX they were not.
 */

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "r1",
    locale: "es",
    kind: "SYNC",
    status: "RUNNING",
    planned: 10,
    completed: 2,
    failed: 0,
    flagged: 0,
    memoryHits: 0,
    remaining: 8,
    done: false,
    promptTokens: 0,
    completionTokens: 0,
    estimatedUsd: 0,
    spentUsd: 0,
    rateUnitsPerMin: null,
    modelBatches: 0,
    etaSeconds: null,
    heartbeatAt: null,
    stale: false,
    enqueuedAt: null,
    startedAt: null,
    finishedAt: null,
    pauseRequested: false,
    cancelRequested: false,
    error: null,
    byEntity: [],
    ...overrides,
  };
}

describe("runControls", () => {
  it("offers pause and cancel to a healthy running run", () => {
    expect(runControls(run())).toEqual({
      pause: true,
      resume: false,
      cancel: true,
      forceCancel: false,
    });
  });

  it("swaps pause for resume once a pause is asked for or honoured", () => {
    expect(runControls(run({ pauseRequested: true }))).toMatchObject({
      pause: false,
      resume: true,
      cancel: true,
    });
    expect(runControls(run({ status: "PAUSED" }))).toMatchObject({
      pause: false,
      resume: true,
      cancel: true,
    });
  });

  it("offers nothing at all on a run that has finished", () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
      expect(runControls(run({ status }))).toEqual({
        pause: false,
        resume: false,
        cancel: false,
        forceCancel: false,
      });
    }
  });

  it("hides every control while a live runner is finalising a cancel", () => {
    expect(runControls(run({ cancelRequested: true }))).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      forceCancel: false,
    });
  });

  /**
   * The blocker. `requestCancel` leaves a run RUNNING when the runner holds a live lease, and both
   * claim queries exclude `cancelRequested` — so a runner killed before the batch boundary wedged
   * the run for ever. Every control was gated on `!cancelRequested`, which left the admin watching
   * a dead run with nothing to press, and `startBackgroundRun` refusing every new run for that
   * language until someone wrote SQL.
   */
  it("offers a force cancel once the cancelling run has gone stale", () => {
    expect(runControls(run({ cancelRequested: true, stale: true }))).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      forceCancel: true,
    });
  });
});

describe("isRunLive", () => {
  it("is true only for a run that can still move on its own", () => {
    expect(isRunLive(null)).toBe(false);
    expect(isRunLive(run({ status: "PENDING" }))).toBe(true);
    expect(isRunLive(run({ status: "PAUSED" }))).toBe(true);
    expect(isRunLive(run({ status: "COMPLETED" }))).toBe(false);
  });
});

describe("shouldPollSample", () => {
  it("polls until the run is terminal", () => {
    expect(shouldPollSample(null, false)).toBe(true);
    expect(shouldPollSample({ status: "RUNNING" }, false)).toBe(true);
    expect(shouldPollSample({ status: "COMPLETED" }, false)).toBe(false);
  });

  // The read is what keeps failing (a deleted run), so the view stays null — and "null means the
  // first read has not landed" would have kept a three-second poll running until the tab closed.
  it("stops once the read has failed, even with nothing to show", () => {
    expect(shouldPollSample(null, true)).toBe(false);
    expect(shouldPollSample({ status: "RUNNING" }, true)).toBe(false);
  });
});

describe("who may start a run", () => {
  it("matches the role startBackgroundRunAction actually requires", () => {
    expect(canStartRuns("ADMIN")).toBe(true);
    expect(canStartRuns("INSTRUCTOR")).toBe(false);
    expect(canStartRuns("STUDENT")).toBe(false);

    // Read from the action itself, so the gate cannot drift away from what it guards: the review
    // page admits INSTRUCTOR, and an instructor pressing a button the action refuses gets a
    // `forbidden()` navigation interrupt instead of a message.
    const actions = readFileSync(
      join(
        process.cwd(),
        "src/app/[locale]/(admin)/admin/languages/actions.ts",
      ),
      "utf8",
    );
    const body = actions.slice(
      actions.indexOf("export async function startBackgroundRunAction"),
    );
    expect(body.slice(0, body.indexOf("\n}"))).toContain(
      'requireUser("ADMIN")',
    );
  });
});

describe("what the progress panel announces", () => {
  /**
   * `aria-live` on the card announced eight stat values, the entity chips and the progress bar on
   * every three-second poll, for the whole of a run that lasts hours. WCAG 2.1 AA is Norwegian law
   * here, and the sibling sample screen had already solved this the right way.
   */
  it("marks the status badge live, and nothing larger", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/admin/languages/run-panel.tsx"),
      "utf8",
    );
    const card = source.slice(source.indexOf("<Card"));
    expect(card.slice(0, card.indexOf(">"))).not.toContain("aria-live");
    expect(source.match(/aria-live/g)).toHaveLength(1);
    // It is the badge that carries it: the status string is the one thing worth re-reading.
    const live = source.indexOf('aria-live="polite"');
    expect(source.slice(live, live + 200)).toContain("status.${statusKey}");
  });
});
