export default function ReaderLoading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6" aria-busy="true">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="h-9 w-full animate-pulse rounded bg-muted" />
      <div className="h-9 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}
