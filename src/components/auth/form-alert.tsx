import { cn } from "@/lib/utils";

/**
 * Form-level message. `role="alert"` so the outcome is announced immediately — a submit that
 * silently fails is invisible to anyone not watching the top of the form.
 */
export function FormAlert({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "success" | "info";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-[var(--radius-control)] px-3 py-2.5 text-sm/relaxed",
        tone === "error" && "bg-destructive/10 text-destructive",
        tone === "success" &&
          "bg-[var(--status-success-soft)] text-[var(--status-success-strong)]",
        tone === "info" && "bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
