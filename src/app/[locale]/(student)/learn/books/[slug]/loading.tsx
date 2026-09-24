export default function BookLoading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 py-6" aria-busy="true">
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="flex gap-4">
        <div className="aspect-[2/3] w-24 animate-pulse rounded-[var(--radius-control)] bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-6 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="h-24 animate-pulse rounded-[calc(var(--radius-base)+6px)] bg-muted" />
      <div className="space-y-px overflow-hidden rounded-[calc(var(--radius-base)+6px)]">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-14 animate-pulse bg-muted" />
        ))}
      </div>
    </div>
  );
}
