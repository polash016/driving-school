"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/** Copies an invite link and confirms it — clipboard writes are silent otherwise. */
export function CopyLinkButton({ url }: { url: string }) {
  const t = useTranslations("admin.invites");
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard permission denied (or an insecure origin) — the link stays visible
          // next to the button, so it can still be selected by hand.
          setCopied(false);
        }
      }}
    >
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}
