/**
 * Grid skeleton (mandate 1: skeletons, never a spinner on navigation).
 *
 * The tiles are the exact dimensions of the real ones, so nothing shifts when the data lands.
 */
export default function TaskSetsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6">
      <div className="space-y-2">
        <div className="h-6 w-32 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
      </div>
      <div className="h-16 animate-pulse rounded-[var(--radius-base)] bg-muted" />
      <div className="grid grid-cols-3 gap-2.5">
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            className="min-h-[4.5rem] animate-pulse rounded-[var(--radius-base)] bg-muted"
          />
        ))}
      </div>
    </div>
  );
}
