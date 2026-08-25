import { z } from "zod";
import {
  variantContentSchema,
  type localizedQuestionSchema,
} from "@/server/contracts/models";

/**
 * Template engine (spec-07 layer 1): deterministic expansion of MasterItem
 * parameterSlots into concrete bilingual variants. PURE — facts are passed in
 * by the caller (facts service), no DB access here.
 *
 * Placeholders: {{slotName}} anywhere in stem/option text/explanation.
 */

// ── parameterSlots contract ──────────────────────────────────────────────────

const bilingualValueSchema = z.object({ en: z.string(), nb: z.string() });

const slotSchema = z.discriminatedUnion("kind", [
  /** Paired bilingual text choices — index i of en corresponds to index i of nb. */
  z.object({
    kind: z.literal("choice"),
    values: z.array(bilingualValueSchema).min(1),
  }),
  /** Numeric choices, shared across locales. */
  z.object({ kind: z.literal("number"), values: z.array(z.number()).min(1) }),
  /** Pinned to the facts table — deterministic, respects legal ground truth. */
  z.object({ kind: z.literal("fact"), factKey: z.string().min(1) }),
]);

export const parameterSlotsSchema = z.object({
  slots: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), slotSchema),
  constraints: z
    .array(
      z.object({
        type: z.literal("distinct"),
        slots: z.array(z.string()).min(2),
      }),
    )
    .default([]),
});
export type ParameterSlots = z.infer<typeof parameterSlotsSchema>;

type LocalizedQuestion = z.infer<typeof localizedQuestionSchema>;
export interface TemplateContent {
  en: LocalizedQuestion & { explanation: string };
  nb: LocalizedQuestion & { explanation: string };
}

export interface ExpandedVariant {
  content: z.infer<typeof variantContentSchema>;
  explanation: { en: string; nb: string };
  /** slotName → chosen value (en rendering for text, raw for number/fact) — for audits. */
  bindings: Record<string, string>;
}

export interface ExpansionIssue {
  combo: Record<string, string>;
  reason: string;
}

const MAX_EXPANSIONS = 200;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

interface ResolvedSlotValue {
  en: string;
  nb: string;
  raw: string; // canonical value for constraint checks / bindings
}

/**
 * Deterministically expand a template. Order: slot names sorted, value order as
 * authored → cartesian product (capped at MAX_EXPANSIONS), constraints filtered,
 * each combo rendered in both locales and validated.
 */
export function expandTemplate(input: {
  template: TemplateContent;
  parameterSlots: ParameterSlots | null;
  facts: Record<string, string>;
}): { variants: ExpandedVariant[]; issues: ExpansionIssue[] } {
  const issues: ExpansionIssue[] = [];

  const slots = input.parameterSlots
    ? parameterSlotsSchema.parse(input.parameterSlots)
    : { slots: {}, constraints: [] };

  const slotNames = Object.keys(slots.slots).sort();
  const valueLists: ResolvedSlotValue[][] = slotNames.map((name) => {
    const slot = slots.slots[name];
    switch (slot.kind) {
      case "choice":
        return slot.values.map((v) => ({ en: v.en, nb: v.nb, raw: v.en }));
      case "number":
        return slot.values.map((v) => ({
          en: String(v),
          nb: String(v),
          raw: String(v),
        }));
      case "fact": {
        const value = input.facts[slot.factKey];
        if (value === undefined) {
          throw new Error(`Unknown fact key in template: ${slot.factKey}`);
        }
        return [{ en: value, nb: value, raw: value }];
      }
    }
  });

  // Cartesian product, deterministic order, capped.
  let combos: ResolvedSlotValue[][] = [[]];
  for (const values of valueLists) {
    combos = combos.flatMap((combo) => values.map((v) => [...combo, v]));
    if (combos.length > MAX_EXPANSIONS) {
      combos = combos.slice(0, MAX_EXPANSIONS);
    }
  }

  const variants: ExpandedVariant[] = [];
  for (const combo of combos) {
    const byName = Object.fromEntries(slotNames.map((n, i) => [n, combo[i]]));
    const comboLabel = Object.fromEntries(
      slotNames.map((n, i) => [n, combo[i].raw]),
    );

    // distinct constraints
    const violates = slots.constraints.some((c) => {
      const raws = c.slots.map((s) => byName[s]?.raw);
      return new Set(raws).size !== raws.length;
    });
    if (violates) continue;

    const rendered = renderCombo(input.template, byName, (reason) =>
      issues.push({ combo: comboLabel, reason }),
    );
    if (rendered) {
      variants.push({ ...rendered, bindings: comboLabel });
    }
  }

  return { variants, issues };
}

function renderCombo(
  template: TemplateContent,
  byName: Record<string, ResolvedSlotValue>,
  onIssue: (reason: string) => void,
): Omit<ExpandedVariant, "bindings"> | null {
  const substitute = (text: string, locale: "en" | "nb"): string | null => {
    let missing: string | null = null;
    const out = text.replace(PLACEHOLDER_RE, (_, name: string) => {
      const value = byName[name];
      if (!value) {
        missing = name;
        return "";
      }
      return value[locale];
    });
    if (missing) {
      onIssue(`unresolved placeholder {{${missing}}}`);
      return null;
    }
    return out;
  };

  const renderSide = (locale: "en" | "nb") => {
    const side = template[locale];
    const stem = substitute(side.stem, locale);
    if (stem === null) return null;
    const options = [];
    for (const o of side.options) {
      const text = substitute(o.text, locale);
      if (text === null) return null;
      options.push({ key: o.key, text });
    }
    const explanation = substitute(side.explanation, locale);
    if (explanation === null) return null;

    // Expansion validator: options must remain distinct after substitution
    const texts = options.map((o) => o.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) {
      onIssue(`${locale}: duplicate option texts after substitution`);
      return null;
    }
    return { stem, options, explanation };
  };

  const en = renderSide("en");
  const nb = renderSide("nb");
  if (!en || !nb) return null;

  const content = variantContentSchema.parse({
    en: { stem: en.stem, options: en.options },
    nb: { stem: nb.stem, options: nb.options },
  });
  return {
    content,
    explanation: { en: en.explanation, nb: nb.explanation },
  };
}
