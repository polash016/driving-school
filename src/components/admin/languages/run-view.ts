import type { Role } from "@prisma/client";
import type { RunDetail } from "@/server/services/i18n/run-control";

/**
 * The rules the languages screens follow while a run is in flight (spec-19).
 *
 * Pure, and deliberately in a module of its own: every one of them is a rule about state rather
 * than about markup — which control is offered, when a poll should stop, who may start a run —
 * and each was got wrong once already in a way no amount of reading the JSX would have caught.
 * Here they can be tested directly, without a DOM.
 */

/** The statuses a run can still move on from — the only ones worth polling or offering controls for. */
export const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "RUNNING",
  "PAUSED",
]);

/**
 * Whether a run can still change on its own. The board asks this to decide between offering
 * "start in background" and handing the language over to the panel's own controls.
 */
export function isRunLive(run: RunDetail | null): run is RunDetail {
  return run !== null && LIVE_RUN_STATUSES.has(run.status);
}

export interface RunControls {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  /** The escape hatch: a cancel whose runner is gone, which only a human can now ask for again. */
  forceCancel: boolean;
}

const NOTHING: RunControls = {
  pause: false,
  resume: false,
  cancel: false,
  forceCancel: false,
};

/**
 * Which controls a run still has to offer.
 *
 * `cancelRequested` hides pause, resume and cancel alike: a run on its way out has nothing left to
 * offer, and pausing it would only delay the batch boundary that ends it. The exception is the
 * state that used to be a dead end — the flag set and the worker gone. `requestCancel` finalises
 * such a run on its second call (it sees the lapsed lease and takes the "no runner" branch), and
 * the worker's reaper gets there on its own, but with every control hidden an admin watching a
 * wedged run had no way to ask for either. So a stale cancel offers cancel again, in its own
 * words: `stale` is exactly "RUNNING and no heartbeat for three minutes".
 */
export function runControls(
  run: Pick<
    RunDetail,
    "status" | "pauseRequested" | "cancelRequested" | "stale"
  >,
): RunControls {
  if (!LIVE_RUN_STATUSES.has(run.status)) return NOTHING;
  if (run.cancelRequested)
    return { ...NOTHING, forceCancel: run.stale, cancel: false };
  return {
    pause: run.status === "RUNNING" && !run.pauseRequested,
    resume: run.status === "PAUSED" || run.pauseRequested,
    cancel: true,
    forceCancel: false,
  };
}

/**
 * Whether the sample preview should still be reading.
 *
 * `view === null` means the first read has not landed yet — but if the read is what keeps failing
 * (a run an admin deleted, say) the view stays null for ever, and polling a failing action every
 * three seconds until the tab closes is a loop with no exit. A failure stops it; the message is
 * already on screen.
 */
export function shouldPollSample(
  view: { status: string } | null,
  failed: boolean,
): boolean {
  if (failed) return false;
  return view === null || LIVE_RUN_STATUSES.has(view.status);
}

/**
 * Who may enqueue a background run.
 *
 * `startBackgroundRunAction` calls `requireUser("ADMIN")`, while the language review page is open
 * to INSTRUCTOR — the person who can judge a translation is whoever speaks the language. Offering
 * an instructor a button that answers with a `forbidden()` navigation interrupt is not an error
 * message, it is a dead end, so the form is rendered only for the role the action accepts.
 */
export function canStartRuns(role: Role): boolean {
  return role === "ADMIN";
}
