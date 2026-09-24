"use client";

import type { PickableImage } from "@/server/services/images/library";

/** The radiogroup grid from the question editor, as a reusable control with a "none" option. */
export function ImagePicker({
  images,
  value,
  onChange,
  label,
  noneLabel,
}: {
  images: PickableImage[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  noneLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        onClick={() => onChange("")}
        className={`flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border p-1.5 text-xs text-muted-foreground ${
          value === "" ? "border-primary ring-2 ring-primary" : "border-input hover:border-muted-foreground"
        }`}
      >
        {noneLabel}
      </button>
      {images
        .filter((image) => image.kind === "UPLOAD")
        .map((image) => {
          const selected = value === image.id;
          return (
            <button
              key={image.id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={image.label}
              onClick={() => onChange(selected ? "" : image.id)}
              className={`flex min-h-11 flex-col items-center gap-1 rounded-[var(--radius-control)] border p-1.5 transition-colors ${
                selected ? "border-primary ring-2 ring-primary" : "border-input hover:border-muted-foreground"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- admin picker; app-served route */}
              <img src={image.url} alt="" loading="lazy" className="h-14 w-full rounded-sm bg-muted object-contain" />
              <span className="line-clamp-1 text-[11px] text-muted-foreground">{image.label}</span>
            </button>
          );
        })}
    </div>
  );
}
