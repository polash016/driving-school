import { createHash } from "node:crypto";
import type { TranslatableEntity } from "@prisma/client";

/**
 * What a translatable UNIT is (spec-15).
 *
 * The unit — not the field — is what gets translated, validated, reviewed and fallen back on. For
 * a question that means the stem, every option and the explanation travel together: a distractor
 * is only wrong *in relation to its stem*, so translating one in isolation is how "Right" becomes
 * "correct" in a question about turning right, and how the answer key quietly stops being right.
 */

/**
 * A question, as one translatable object.
 *
 * `explanation` is optional because the variant content a student is served deliberately does not
 * carry one — the explanation lives on `ItemVariant.explanation` and is revealed only after
 * grading. The same merge therefore works on both shapes.
 */
export interface QuestionPayload {
  stem: string;
  options: Array<{ key: string; text: string }>;
  explanation?: string;
}

export interface TopicPayload {
  name: string;
  description?: string;
}

export interface SignPayload {
  name: string;
  meaning: string;
}

export interface NamePayload {
  name: string;
}

export interface MessagePayload {
  text: string;
}

export type UnitPayload =
  QuestionPayload | TopicPayload | SignPayload | NamePayload | MessagePayload;

export interface TranslationUnit {
  entity: TranslatableEntity;
  entityId: string;
  /** English is the pivot the model translates from; Norwegian is supplied as the legal original. */
  en: UnitPayload;
  nb?: UnitPayload;
  /**
   * The option that must remain the only defensible answer. Passed to the model so it can be told
   * so explicitly, and used by QA to check the answer did not move.
   */
  correctOptionKey?: string;
  /** A short human label for logs and the admin run board. */
  label: string;
  sourceHash: string;
}

/** Stable JSON: key order can never change the hash, or everything looks stale at once. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The hash a translation is stamped with.
 *
 * Covers both source sides and the glossary version: a change to either the text or the
 * terminology it should use makes existing translations stale, and staleness is the *only* thing
 * a sync re-translates. Everything else is skipped without an AI call.
 */
export function hashUnit(
  unit: Pick<TranslationUnit, "entity" | "en" | "nb">,
  glossaryVersion: number,
): string {
  return createHash("sha256")
    .update(
      canonical({
        e: unit.entity,
        en: unit.en,
        nb: unit.nb ?? null,
        g: glossaryVersion,
      }),
    )
    .digest("hex");
}

/** The memory key: the same source text, in the same kind of context, translated once ever. */
export function memoryHash(
  entity: TranslatableEntity,
  en: UnitPayload,
  glossaryVersion: number,
): string {
  return createHash("sha256")
    .update(canonical({ e: entity, en, g: glossaryVersion }))
    .digest("hex");
}

export function isQuestionEntity(entity: TranslatableEntity): boolean {
  return entity === "MASTER_ITEM" || entity === "ITEM_VARIANT";
}

/** Every string in a payload, for the checks that do not care about structure. */
export function payloadStrings(payload: UnitPayload): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") out.push(value);
    else if (key === "options" && Array.isArray(value)) {
      for (const option of value as Array<{ text?: unknown }>) {
        if (typeof option?.text === "string") out.push(option.text);
      }
    }
  }
  return out;
}
