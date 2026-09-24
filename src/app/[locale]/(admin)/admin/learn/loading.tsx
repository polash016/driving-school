/** Skeleton for the Learn list: the header, the tab strip and eight rows, never a spinner. */
export default function LearnAdminLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6" aria-busy="true">
      <div className="space-y-2">
        <div className="h-7 w-32 animate-pulse rounded bg-muted" />
        <div className="h-4 w-80 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-11 w-72 animate-pulse rounded bg-muted" />
      <div className="space-y-px overflow-hidden rounded-[var(--radius-base)] border border-border">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-14 animate-pulse bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
