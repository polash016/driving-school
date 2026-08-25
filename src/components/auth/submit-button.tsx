"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * Submit button that reflects the action's pending state. Progress lives inside the control
 * the user pressed — navigation never gets a spinner (mandate 1).
 */
export function SubmitButton({
  label,
  pendingLabel,
  className,
  variant,
  name,
  value,
}: {
  label: string;
  pendingLabel?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  /** Submits this field with the form — how one form offers several actions. */
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      size="lg"
      variant={variant}
      disabled={pending}
      aria-busy={pending}
      className={className}
      name={name}
      value={value}
    >
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  );
}
