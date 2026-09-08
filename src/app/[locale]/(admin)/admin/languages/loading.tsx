/**
 * Languages skeleton (mandate 1: skeletons, never a spinner on navigation).
 *
 * This page waits on a coverage read AND a run detail per language, so it is the one admin screen
 * with a visible gap. The blocks match the real card's rhythm — heading, coverage bar, button row
 * — so nothing jumps when the data lands.
 */
export default function LanguagesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-8">
      <div className="space-y-2">
        <div className="h-6 w-32 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded-md bg-muted" />
      </div>

      <div className="h-5 w-40 animate-pulse rounded-full bg-muted" />

      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <div className="h-5 w-48 animate-pulse rounded-md bg-muted" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
            <div className="flex flex-wrap gap-2">
              <div className="h-9 w-36 animate-pulse rounded-[var(--radius-control)] bg-muted" />
              <div className="h-9 w-36 animate-pulse rounded-[var(--radius-control)] bg-muted" />
              <div className="h-9 w-32 animate-pulse rounded-[var(--radius-control)] bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
