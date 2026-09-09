"use client";

import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export interface SwitchableLanguage {
  code: string;
  nativeName: string;
  shortLabel: string;
}

/**
 * Language switcher.
 *
 * For a student who reads Arabic better than Norwegian this is not a settings widget — it is the
 * door into the product, and it sits in a 56px header next to three other controls. So the trigger
 * is the short code alone ("ES"), and the panel carries the recognition: each language written in
 * its OWN name and script, with that same code beside it as a chip. The chip is what teaches the
 * mapping — after one look at the list, "ES" in the header means Español rather than a mystery.
 *
 * Two languages skip the menu entirely: a segmented control shows both and changes in one tap,
 * which no dropdown can beat. Past two that stops fitting a 390px phone.
 *
 * Built by hand rather than on a select or a menu library: a native `<select>` cannot be styled to
 * match the glass chrome around it, and this is four rows of behaviour, not a dependency.
 */
export function LanguageSwitcher({
  languages,
}: {
  languages: SwitchableLanguage[];
}) {
  const locale = useLocale();
  const t = useTranslations("language");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState(false);

  const switchTo = useCallback(
    (code: string) => {
      if (code === locale) return;
      setPending(true);
      router.replace(pathname, { locale: code });
    },
    [locale, pathname, router],
  );

  if (languages.length < 2) return null;
  if (languages.length === 2) {
    return (
      <SegmentedSwitcher
        languages={languages}
        locale={locale}
        label={t("label")}
        pending={pending}
        onSelect={switchTo}
      />
    );
  }
  return (
    <MenuSwitcher
      languages={languages}
      locale={locale}
      label={t("label")}
      pending={pending}
      onSelect={switchTo}
    />
  );
}

interface SwitcherProps {
  languages: SwitchableLanguage[];
  locale: string;
  label: string;
  pending: boolean;
  onSelect: (code: string) => void;
}

/**
 * The code, as it appears in the trigger and again beside every name in the list. Tabular figures
 * and a hair of tracking so two-letter codes of different widths ("NO", "AR") sit on one rhythm.
 */
function CodeChip({ code, active }: { code: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-5 min-w-8 items-center justify-center rounded-[0.3rem] px-1 font-mono text-[0.6875rem] font-semibold tracking-[0.06em] tabular-nums transition-colors",
        active
          ? "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
          : "bg-muted text-muted-foreground",
      )}
    >
      {code}
    </span>
  );
}

function SegmentedSwitcher({
  languages,
  locale,
  label,
  pending,
  onSelect,
}: SwitcherProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-[var(--radius-control)] bg-muted p-0.5"
    >
      {languages.map((language) => {
        const active = language.code === locale;
        return (
          <button
            key={language.code}
            type="button"
            aria-pressed={active}
            disabled={pending}
            onClick={() => onSelect(language.code)}
            className={cn(
              "min-h-10 min-w-10 rounded-[calc(var(--radius-control)-2px)] px-2 font-mono text-[0.6875rem] font-semibold tracking-[0.06em] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-glass)]",
              "disabled:opacity-60",
              active
                ? "bg-card text-foreground shadow-card"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden>{language.shortLabel}</span>
            {/* `lang` so a screen reader pronounces the name in its own language rather than
                reading "Norsk bokmål" with English phonetics. */}
            <span className="sr-only" lang={language.code}>
              {language.nativeName}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MenuSwitcher({
  languages,
  locale,
  label,
  pending,
  onSelect,
}: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const current =
    languages.find((language) => language.code === locale) ?? null;
  const activeIndex = languages.findIndex(
    (language) => language.code === locale,
  );

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Pointer down, not click: closing on click would fire after the browser had already begun
  // treating the press as an interaction with whatever is underneath.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Opening moves focus to the current language, so a keyboard user starts where they are rather
  // than at the top of a list they have to count through.
  useEffect(() => {
    if (!open) return;
    const index = activeIndex >= 0 ? activeIndex : 0;
    itemRefs.current[index]?.focus();
  }, [open, activeIndex]);

  function focusItem(index: number) {
    const wrapped = (index + languages.length) % languages.length;
    itemRefs.current[wrapped]?.focus();
  }

  function onMenuKeyDown(event: React.KeyboardEvent, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(languages.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        // Tabbing out of a menu closes it, but must not steal the focus move itself.
        close(false);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={pending}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "inline-flex h-11 items-center gap-1 rounded-[var(--radius-control)] px-2 text-foreground transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-glass)]",
          "disabled:opacity-60",
          open && "bg-accent",
        )}
      >
        <span
          aria-hidden
          className="font-mono text-[0.6875rem] font-semibold tracking-[0.06em]"
        >
          {current?.shortLabel ?? locale.toUpperCase()}
        </span>
        {current ? (
          <span className="sr-only" lang={current.code}>
            {current.nativeName}
          </span>
        ) : null}
        <CaretDownIcon
          aria-hidden
          weight="bold"
          className={cn(
            "size-3 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          /* `end-0` not `right-0`: in Arabic the header flips and the panel must hang from the
             same edge as its trigger. */
          className="glass absolute end-0 top-[calc(100%+0.375rem)] z-50 min-w-44 overflow-hidden rounded-[var(--radius-base)] bg-[var(--surface-glass-strong)] p-1 backdrop-blur-[var(--glass-blur)] backdrop-saturate-[var(--glass-saturate)]"
        >
          {languages.map((language, index) => {
            const active = language.code === locale;
            return (
              <button
                key={language.code}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                lang={language.code}
                onKeyDown={(event) => onMenuKeyDown(event, index)}
                onClick={() => {
                  close(false);
                  onSelect(language.code);
                }}
                /* Every name at full contrast, including the ones you are not using: the language
                   a reader is hunting for must not be dimmer than the one they are trying to
                   leave. State is carried by the chip and the check, not by fading the options. */
                className={cn(
                  "flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 text-start text-sm text-foreground transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "font-medium" : "hover:bg-accent",
                )}
              >
                <CodeChip code={language.shortLabel} active={active} />
                <span className="flex-1 truncate">{language.nativeName}</span>
                {/* A check, not colour alone: state has to survive a monochrome display and
                    WCAG 1.4.1. */}
                <CheckIcon
                  aria-hidden
                  weight="bold"
                  className={cn(
                    "size-3.5 shrink-0 text-[var(--brand-primary)]",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
