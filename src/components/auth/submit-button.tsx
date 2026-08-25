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
  disabled = false,
  icon,
}: {
  label: string;
  pendingLabel?: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  /** Submits this field with the form — how one form offers several actions. */
  name?: string;
  value?: string;
  /** Unavailable for a reason the caller knows about, on top of the pending state. */
  disabled?: boolean;
  /** Decorative glyph shown above the label. Hidden from assistive tech by the caller. */
  icon?: React.ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      size="lg"
      variant={variant}
      disabled={pending || disabled}
      aria-busy={pending}
      className={className}
      name={name}
      value={value}
    >
      {icon}
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  );
}
