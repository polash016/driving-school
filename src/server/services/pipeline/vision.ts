import sharp from "sharp";
import type { PrismaClient, SignClass } from "@prisma/client";
import { z } from "zod";
import { aiJson } from "@/server/ai/client";
import {
  sceneDetectionPrompt,
  signDiscriminationPrompt,
} from "@/server/ai/prompts/vision";
import {
  contextSheetSchema,
  type ContextSheet,
} from "@/server/contracts/image-pipeline";
import { createRng, shuffle } from "@/server/services/quiz/rng";
import { logger } from "@/lib/logger";
import { NotFoundError } from "@/lib/errors";
import type { StorageDriver } from "@/server/storage";

/**
 * Reading a traffic photograph into a context sheet (spec-06, mode 2).
 *
 * The governing rule: the model may describe, but it may not be the source of a FACT that a legal
 * citation will hang off. Sign identity is the only fact here that carries legal weight, so it is
 * the only thing put through three defences:
 *
 *   1. closed vocabulary  — identity is a choice from the registry, never free text
 *   2. repeated runs      — a sign survives only if independent passes agree
 *   3. discrimination     — the crop is re-checked against same-class graphics, with "none" allowed
 *
 * `confidence` is carried through for a human to look at and is deliberately used for NOTHING.
 * Measured on this deployment's own model, a wrong identification came back at 0.95.
 */

/** Independent detection passes. Odd, so agreement is never a tie. */
const PASSES = 3;
/** How many passes must contain a sign for it to survive. */
const QUORUM = 2;
/** Same-class graphics shown alongside the crop in the discrimination pass. */
const CANDIDATE_COUNT = 5;
/** A crop smaller than this is not worth asking about; the answer would be noise either way. */
const MIN_CROP_PX = 24;
/**
 * How much to widen a reported box before cropping — and it is deliberately generous.
 *
 * Measured against a scene whose sign positions were known exactly: the model placed one box some
 * 10% of the image width off, enough that a 15% pad still sliced the sign in half. A half-sign is
 * what makes the discrimination pass answer "none of these" and throw away a correct detection.
 * Extra surroundings cost nothing — that pass compares against candidate graphics, so context does
 * not confuse it, whereas a clipped sign does.
 */
const CROP_PADDING = 0.4;

const boxObjectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

/**
 * Accept the several shapes a model actually answers with, and normalise to {x, y, w, h}.
 *
 * Gemini returns `[[y, x, h, w]]` — y-first, and nested one level — rather than the object the
 * prompt asks for. Verified against known sign positions: of the plausible orderings, y-first fits
 * with roughly a third of the error of x-first, and the alternatives put ymax above ymin.
 * The object form is still requested and still accepted, since a model that obliges is easier to
 * be sure about than one whose array order we inferred.
 */
/**
 * A model reports a box in whichever shape and scale it feels like on the day. Observed from the
 * SAME model on the same picture, minutes apart: `[[y, x, h, w]]` as fractions, and the same
 * nested array on Gemini's documented 0–1000 grid. Both are normalised here rather than argued
 * with — and the object form the prompt asks for is passed straight through.
 *
 * Scale is detected, not assumed: a fractional box can legitimately hold 1.0 (a sign filling the
 * frame), so only a value ABOVE 1 can mean the thousandths grid.
 */
export function normaliseBbox(value: unknown): unknown {
  const flat =
    Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  if (
    Array.isArray(flat) &&
    flat.length === 4 &&
    flat.every((n) => typeof n === "number")
  ) {
    const numbers = flat as number[];
    const scale = numbers.some((n) => n > 1) ? 1000 : 1;
    const [y, x, h, w] = numbers.map((n) => n / scale);
    return { x, y, w, h };
  }
  return value;
}

const bboxSchema = z.preprocess(normaliseBbox, boxObjectSchema);

/**
 * Pass 1 output. No `applicableRules`: those come from the knowledge base, not from the model.
 *
 * Strict on `code` — that is the one field a legal citation hangs off, and a malformed one must
 * fail the pass. Everything else is forgiving on purpose: `confidence` is explicitly used for
 * nothing, and the scene text is prose the admin can edit, so discarding a whole reading because
 * the model left one of them out would throw away the part that matters over the part that
 * does not. (Measured: it omits `confidence` and `conditions` routinely.)
 */
const detectionSchema = z.object({
  signs: z
    .array(
      z.object({
        code: z.string(),
        confidence: z.number().min(0).max(1).default(0.5),
        bbox: bboxSchema.optional(),
      }),
    )
    .default([]),
  roadMarkings: z.array(z.string()).default([]),
  actors: z.array(z.string()).default([]),
  conditions: z
    .object({
      lighting: z.string().default("unknown"),
      weather: z.string().default("unknown"),
      roadType: z.string().default("unknown"),
    })
    .default({ lighting: "unknown", weather: "unknown", roadType: "unknown" }),
  situationSummary: z.string().min(1),
});

const discriminationSchema = z.object({
  code: z.string(),
  reason: z.string(),
});

export interface ExtractionResult {
  sheet: ContextSheet;
  /** True when every surviving sign also passed discrimination — otherwise a human is needed. */
  settled: boolean;
  /** Signs the passes disagreed on, or that discrimination rejected. Shown to the admin. */
  unresolved: string[];
}

type RegistrySign = {
  code: string;
  name: string;
  signClass: SignClass;
  svgPath: string;
};

function dataUri(bytes: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * Crop a reported bbox with padding, in pixels, clamped to the image.
 *
 * Exported because the geometry is worth testing on its own: an off-by-one here silently feeds the
 * discrimination pass the wrong patch of road, and it would still confidently answer.
 */
export function cropRect(
  bbox: z.infer<typeof boxObjectSchema>,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  const padX = bbox.w * CROP_PADDING;
  const padY = bbox.h * CROP_PADDING;
  const left = Math.max(0, Math.round((bbox.x - padX) * width));
  const top = Math.max(0, Math.round((bbox.y - padY) * height));
  const right = Math.min(width, Math.round((bbox.x + bbox.w + padX) * width));
  const bottom = Math.min(
    height,
    Math.round((bbox.y + bbox.h + padY) * height),
  );
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth < MIN_CROP_PX || cropHeight < MIN_CROP_PX) return null;
  return { left, top, width: cropWidth, height: cropHeight };
}

/**
 * Keep the signs that enough independent passes agree on.
 *
 * Exported and pure so the quorum rule is testable without spending a vision call. Confidence is
 * averaged for display only — it never decides anything.
 */
export function agreedSigns(
  passes: {
    code: string;
    confidence: number;
    bbox?: z.infer<typeof boxObjectSchema>;
  }[][],
  quorum = QUORUM,
): {
  code: string;
  confidence: number;
  bbox?: z.infer<typeof boxObjectSchema>;
  agreement: number;
}[] {
  const seen = new Map<
    string,
    {
      confidences: number[];
      bbox?: z.infer<typeof boxObjectSchema>;
      passes: number;
    }
  >();

  for (const pass of passes) {
    // One vote per sign per pass: a model that lists the same sign twice must not out-vote itself.
    for (const code of new Set(pass.map((sign) => sign.code))) {
      const best = pass.find((sign) => sign.code === code)!;
      const entry = seen.get(code) ?? { confidences: [], passes: 0 };
      entry.confidences.push(best.confidence);
      entry.passes += 1;
      entry.bbox ??= best.bbox;
      seen.set(code, entry);
    }
  }

  return [...seen.entries()]
    .filter(([, entry]) => entry.passes >= quorum)
    .map(([code, entry]) => ({
      code,
      confidence:
        entry.confidences.reduce((sum, value) => sum + value, 0) /
        entry.confidences.length,
      bbox: entry.bbox,
      agreement: entry.passes,
    }));
}

/** Candidates for the discrimination pass: the claimed sign plus near neighbours of its class. */
export function discriminationCandidates(
  claimed: RegistrySign,
  registry: RegistrySign[],
  seed: string,
): RegistrySign[] {
  const sameClass = registry.filter(
    (sign) =>
      sign.signClass === claimed.signClass && sign.code !== claimed.code,
  );
  const others = shuffle(createRng(seed), sameClass).slice(
    0,
    CANDIDATE_COUNT - 1,
  );
  // Shuffled again so the right answer is not always first — position is a tell models pick up on.
  return shuffle(createRng(`${seed}:order`), [claimed, ...others]);
}

export async function extractContextSheet(
  db: PrismaClient,
  storage: StorageDriver,
  imageAssetId: string,
): Promise<ExtractionResult> {
  const image = await db.imageAsset.findFirst({
    where: { id: imageAssetId, deletedAt: null },
    select: { id: true, storagePath: true },
  });
  if (!image) throw new NotFoundError({ imageAssetId });

  const registryRows = await db.sign.findMany({
    where: { isActive: true },
    select: { code: true, name: true, signClass: true, svgPath: true },
    orderBy: { code: "asc" },
  });
  const registry: RegistrySign[] = registryRows.map((row) => ({
    code: row.code,
    name: (row.name as { en?: string }).en ?? row.code,
    signClass: row.signClass,
    svgPath: row.svgPath,
  }));
  const byCode = new Map(registry.map((sign) => [sign.code, sign]));

  await db.imageAsset.update({
    where: { id: image.id },
    data: { status: "ANALYZING" },
    select: { id: true },
  });

  const { body: bytes } = await storage.get(image.storagePath);
  const meta = await sharp(bytes).metadata();
  const photo = {
    type: "image_url" as const,
    image_url: { url: dataUri(bytes, "image/jpeg") },
  };

  // ── Pass 1, three times ──────────────────────────────────────────────────
  // The catalogue order is shuffled per pass. Without it the three runs share the same positional
  // bias and "agreement" would mean the model repeated itself, not that it was independently sure.
  const passes: z.infer<typeof detectionSchema>[] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    const catalogue = shuffle(
      createRng(`${image.id}:catalogue:${pass}`),
      registry,
    )
      .map((sign) => `${sign.code} · ${sign.name}`)
      .join("\n");
    const result = await aiJson({
      task: "vision",
      prompt: sceneDetectionPrompt,
      vars: { signCatalogue: catalogue },
      schema: detectionSchema,
      userContent: [photo],
      temperature: 0,
    });
    // A code the model invented is dropped, never repaired: a near-miss repair would silently
    // attach the wrong rule, which is the failure this whole module exists to prevent.
    passes.push({
      ...result.data,
      signs: result.data.signs.filter((sign) => byCode.has(sign.code)),
    });
  }

  const agreed = agreedSigns(passes.map((pass) => pass.signs));
  const unresolved: string[] = [];

  // Anything one pass saw and the others did not is worth telling the admin about.
  for (const code of new Set(
    passes.flatMap((pass) => pass.signs.map((sign) => sign.code)),
  )) {
    if (!agreed.some((sign) => sign.code === code)) {
      unresolved.push(`${code} — seen in only one of ${PASSES} readings`);
    }
  }

  // ── Pass 2: discriminate each survivor against its own class ─────────────
  const confirmed: ContextSheet["signs"] = [];
  for (const candidate of agreed) {
    const claimed = byCode.get(candidate.code)!;
    if (!candidate.bbox || !meta.width || !meta.height) {
      // No box means nothing to crop; the claim stands on agreement alone and is flagged so the
      // admin knows it was never visually re-checked.
      confirmed.push({
        signCode: candidate.code,
        confidence: candidate.confidence,
      });
      unresolved.push(
        `${candidate.code} — no region reported, not visually re-checked`,
      );
      continue;
    }
    const rect = cropRect(candidate.bbox, meta.width, meta.height);
    if (!rect) {
      unresolved.push(`${candidate.code} — region too small to re-check`);
      continue;
    }

    const crop = await sharp(bytes)
      .extract(rect)
      .resize(320, 320, { fit: "inside" })
      .png()
      .toBuffer();
    const candidates = discriminationCandidates(
      claimed,
      registry,
      `${image.id}:${candidate.code}`,
    );
    const graphics = await Promise.all(
      candidates.map(async (sign) => ({
        type: "image_url" as const,
        image_url: {
          url: dataUri(await sharp(`public${sign.svgPath}`).png().toBuffer()),
        },
      })),
    );

    const verdict = await aiJson({
      task: "vision",
      prompt: signDiscriminationPrompt,
      vars: {
        candidates: candidates.map((sign) => ({
          code: sign.code,
          name: sign.name,
        })),
      },
      schema: discriminationSchema,
      userContent: [
        { type: "text", text: "Cropped region:" },
        { type: "image_url", image_url: { url: dataUri(crop) } },
        { type: "text", text: "Candidate signs, in listed order:" },
        ...graphics,
      ],
      temperature: 0,
    });

    if (verdict.data.code === candidate.code) {
      confirmed.push({
        signCode: candidate.code,
        confidence: candidate.confidence,
        bbox: candidate.bbox,
      });
    } else if (byCode.has(verdict.data.code)) {
      // Discrimination overrules pass 1 — a side-by-side comparison against the real graphic beats
      // recall from a list of names, which is exactly what the probe measured.
      confirmed.push({
        signCode: verdict.data.code,
        confidence: candidate.confidence,
        bbox: candidate.bbox,
      });
      unresolved.push(
        `${candidate.code} → ${verdict.data.code} on re-check: ${verdict.data.reason}`,
      );
    } else {
      unresolved.push(
        `${candidate.code} — rejected on re-check: ${verdict.data.reason}`,
      );
    }
  }

  // The scene description is taken from the first pass; it carries no legal weight on its own and
  // is the admin's to correct.
  const [first] = passes;
  const sheet = contextSheetSchema.parse({
    signs: confirmed,
    roadMarkings: first.roadMarkings,
    actors: first.actors,
    conditions: first.conditions,
    situationSummary: first.situationSummary,
    // Filled from the knowledge base at generation time, never by the vision model.
    applicableRules: [],
  });

  const settled = unresolved.length === 0 && confirmed.length > 0;
  await db.imageAsset.update({
    where: { id: image.id },
    data: {
      aiContextSheet: sheet,
      status: settled ? "IN_REVIEW" : "NEEDS_HUMAN_ID",
    },
    select: { id: true },
  });

  logger.info(
    {
      imageAssetId: image.id,
      confirmed: confirmed.length,
      unresolved: unresolved.length,
      settled,
    },
    "context sheet extracted",
  );
  return { sheet, settled, unresolved };
}
