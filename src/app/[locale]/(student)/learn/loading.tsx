export default function LearnHubLoading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-6" aria-busy="true">
      <div className="space-y-2">
        <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
      </div>
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="w-36 shrink-0 space-y-2 rounded-[calc(var(--radius-base)+6px)] p-2.5">
            <div className="aspect-[2/3] animate-pulse rounded-[var(--radius-control)] bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-9 w-24 animate-pulse rounded-full bg-muted" />
        ))}
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-[calc(var(--radius-base)+6px)] bg-muted" />
      ))}
    </div>
  );
}
