"use client";

import { ListIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * The header's account links on a phone.
 *
 * Four inline text buttons plus the language switcher and theme toggle are ~392px wide, which
 * overflows the 390px design target on every signed-in page — so below `sm` they collapse behind
 * this menu and the header fits. From `sm` up the links render inline as before.
 *
 * The trigger and the panel are the only client code here: the links themselves are rendered on
 * the server by `AccountMenu` and passed in, so no session detail reaches the bundle.
 */
export function AccountSheet({ children }: { children: ReactNode }) {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11 sm:hidden"
        aria-label={t("menu")}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ListIcon size={22} weight="bold" aria-hidden />
      </Button>

      <SheetContent side="bottom" className="mx-auto gap-0 sm:max-w-md">
        <SheetHeader className="pb-1">
          <SheetTitle>{t("menu")}</SheetTitle>
        </SheetHeader>
        {/* Closing on click keeps a link tap from leaving the panel open over the new page. */}
        <div
          className="flex flex-col gap-1 px-4 pb-5 [&_a]:w-full [&_a]:justify-start [&_button]:w-full [&_button]:justify-start [&_form]:w-full"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
