import { Card, CardContent } from "@/components/ui/card";

/**
 * Frame for every auth screen: 390px-first, centered max-w-md on desktop (CLAUDE.md
 * student-panel rule). One card, generous spacing, no decoration competing with the form.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 py-8">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm/relaxed text-muted-foreground">{subtitle}</p>
        ) : null}
      </header>
      <Card className="[--card-spacing:--spacing(5)]">
        <CardContent>{children}</CardContent>
      </Card>
      {footer ? (
        <div className="text-center text-sm text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
