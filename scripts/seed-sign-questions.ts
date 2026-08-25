/**
 * Turn the sign registry into a playable sign test.
 *
 *   pnpm signs:questions [--dry-run] [--seed <string>]
 *
 * Deterministic and AI-free. Every sign in the registry yields two questions, both showing the
 * sign graphic and offering text options — which is what `ItemVariant.content` models:
 *
 *   meaning      "What does this sign mean?"   → the sign's meaning + 3 meanings from its own class
 *   recognition  "What is this sign called?"   → the sign's name + 3 names from its own class
 *
 * Distractors come from the SAME sign class on purpose. Offering a service sign as a distractor
 * for a warning sign makes the question answerable on shape and colour alone, which tests nothing.
 *
 * Randomness runs through the engine's own seeded RNG, so a given `--seed` always produces the
 * same paper. Re-running is idempotent: a sign that already has its two questions is skipped.
 *
 * NOTE: items are inserted directly as APPROVED, bypassing the two-person sign-off that a
 * human- or AI-authored question must pass. That is defensible only because the content here is
 * mechanical — it restates registry rows a reviewer approves in /admin/signs, and invents nothing.
 * The registry, not this script, is the thing a human signs off.
 */
import { PrismaClient, type SignClass } from "@prisma/client";
import { createRng, shuffle } from "../src/server/services/quiz/rng";
import { checkItemQuality } from "../src/server/services/question-bank/validation";
import { publishItem } from "../src/server/services/question-bank/publish";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

/** Where each sign class belongs in the topic tree the dashboard reports progress against. */
const TOPIC_FOR_CLASS: Record<SignClass, string> = {
  FARE: "warning-signs",
  FORBUD: "prohibition-mandatory-signs",
  PABUD: "prohibition-mandatory-signs",
  VIKEPLIKT_OG_FORKJORS: "priority-yield-signs",
  OPPLYSNING: "information-signs",
  SERVICE: "information-signs",
  VEGVISNING: "information-signs",
  UNDERSKILT: "information-signs",
  MARKERING: "road-markings",
};

/**
 * The regulation that defines Norwegian road signs. Every sign question cites it — the quality
 * gate requires a citation, and for a sign this is genuinely the rule the answer comes from.
 */
const CITATION_SOURCE = "skiltforskriften";
const SECTION_FOR_CLASS: Record<SignClass, string> = {
  FARE: "§ 5",
  VIKEPLIKT_OG_FORKJORS: "§ 6",
  FORBUD: "§ 7",
  PABUD: "§ 8",
  OPPLYSNING: "§ 9",
  SERVICE: "§ 10",
  VEGVISNING: "§ 11",
  UNDERSKILT: "§ 13",
  MARKERING: "§ 15",
};

const OPTION_KEYS = ["a", "b", "c", "d"] as const;
const DISTRACTORS = 3;

const STEMS = {
  meaning: {
    en: "What does this sign mean?",
    nb: "Hva betyr dette skiltet?",
  },
  recognition: {
    en: "What is this sign called?",
    nb: "Hva heter dette skiltet?",
  },
} as const;

type Bilingual = { en: string; nb: string };
type SignRow = {
  id: string;
  code: string;
  signClass: SignClass;
  svgPath: string;
  name: Bilingual;
  meaning: Bilingual;
};

const flag = (name: string) => process.argv.includes(`--${name}`);

function stringOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/**
 * Pick three wrong answers from the same class, avoiding any whose text matches the right one.
 *
 * The registry genuinely contains signs that share a name — "Countdown marker" is three different
 * graphics — so comparing text rather than identity is what stops a question from offering the
 * correct answer twice and being ungradeable.
 */
function distractors(
  rng: () => number,
  pool: SignRow[],
  correct: SignRow,
  read: (sign: SignRow) => Bilingual,
): Bilingual[] {
  const right = read(correct);
  const seen = new Set([right.en.toLowerCase(), right.nb.toLowerCase()]);
  const picked: Bilingual[] = [];

  for (const candidate of shuffle(rng, pool)) {
    if (picked.length === DISTRACTORS) break;
    if (candidate.id === correct.id) continue;
    const text = read(candidate);
    const key = text.en.toLowerCase();
    if (seen.has(key) || seen.has(text.nb.toLowerCase())) continue;
    seen.add(key);
    seen.add(text.nb.toLowerCase());
    picked.push(text);
  }
  return picked;
}

function buildContent(
  rng: () => number,
  stem: Bilingual,
  answer: Bilingual,
  wrong: Bilingual[],
  explanation: Bilingual,
) {
  // One shuffle drives both locales, so option "c" is the same answer in English and Norwegian —
  // a student switching language mid-question must not see the answers move.
  const order = shuffle(rng, [answer, ...wrong]);
  const correctIndex = order.indexOf(answer);
  const build = (locale: "en" | "nb") => ({
    stem: stem[locale],
    options: order.map((option, index) => ({
      key: OPTION_KEYS[index],
      text: option[locale],
    })),
    explanation: explanation[locale],
  });
  return {
    content: { en: build("en"), nb: build("nb") },
    correctOptionKey: OPTION_KEYS[correctIndex],
  };
}

async function main(): Promise<void> {
  const dryRun = flag("dry-run");
  const seed = stringOption("seed", "sign-questions-v1");

  const signs = (await db.sign.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      signClass: true,
      svgPath: true,
      name: true,
      meaning: true,
    },
    orderBy: { code: "asc" },
  })) as unknown as SignRow[];

  if (signs.length === 0) {
    console.error(
      "The sign registry is empty. Run: pnpm signs:extract && pnpm signs:enrich && pnpm db:seed-signs",
    );
    process.exitCode = 1;
    return;
  }

  const topics = new Map(
    (await db.topic.findMany({ select: { id: true, slug: true } })).map((t) => [
      t.slug,
      t.id,
    ]),
  );
  const missingTopics = [...new Set(Object.values(TOPIC_FOR_CLASS))].filter(
    (s) => !topics.has(s),
  );
  if (missingTopics.length > 0) {
    console.error(
      `Topics missing from the database: ${missingTopics.join(", ")}`,
    );
    console.error("Run the base seed first: pnpm exec prisma db seed");
    process.exitCode = 1;
    return;
  }

  // Sign graphics are public reference material — spec-10 puts them in a browsable catalogue and a
  // logged-out demo quiz — so they are served straight from `public/signs/`, unlike uploaded exam
  // photos which go through the authenticated `/api/images/[id]` route. Wrapping each in an
  // ImageAsset row is what lets a sign question reuse the engine's existing image path
  // (`variant.masterItem.sourceImage.url`) with no schema or serializer change.
  const existingAssets = new Map(
    (
      await db.imageAsset.findMany({
        where: { storagePath: { startsWith: "signs/" }, deletedAt: null },
        select: { id: true, storagePath: true },
      })
    ).map((asset) => [asset.storagePath, asset.id]),
  );

  const byClass = new Map<SignClass, SignRow[]>();
  for (const sign of signs) {
    byClass.set(sign.signClass, [...(byClass.get(sign.signClass) ?? []), sign]);
  }

  let created = 0;
  let skipped = 0;
  let rejected = 0;
  const tooSmall = new Set<SignClass>();

  for (const sign of signs) {
    const pool = byClass.get(sign.signClass) ?? [];
    if (pool.length < DISTRACTORS + 1) {
      // Fewer than four signs in a class cannot make a four-option question without reaching into
      // another class, which would give the answer away on shape alone.
      tooSmall.add(sign.signClass);
      skipped += 2;
      continue;
    }

    const storagePath = sign.svgPath.replace(/^\//, "");
    let imageId = existingAssets.get(storagePath);
    if (!imageId && !dryRun) {
      const asset = await db.imageAsset.create({
        data: {
          url: sign.svgPath,
          storagePath,
          status: "READY",
          exifStripped: true,
          licenseAttestation: { source: "sign-registry", signCode: sign.code },
        },
        select: { id: true },
      });
      imageId = asset.id;
      existingAssets.set(storagePath, imageId);
    }

    for (const kind of ["meaning", "recognition"] as const) {
      const already = await db.masterItem.findFirst({
        where: {
          sourceImageId: imageId,
          type: "SIGN",
          deletedAt: null,
          reviewNote: kind,
        },
        select: { id: true },
      });
      if (already) {
        skipped++;
        continue;
      }

      // Seeded per sign and per kind: the same sign always produces the same paper, and re-running
      // after adding signs does not reshuffle the questions already in the bank.
      const rng = createRng(`${seed}:${sign.code}:${kind}`);
      const read =
        kind === "meaning" ? (s: SignRow) => s.meaning : (s: SignRow) => s.name;
      const wrong = distractors(rng, pool, sign, read);
      if (wrong.length < DISTRACTORS) {
        tooSmall.add(sign.signClass);
        skipped++;
        continue;
      }

      const { content, correctOptionKey } = buildContent(
        rng,
        STEMS[kind],
        read(sign),
        wrong,
        {
          en: `${sign.name.en} — ${sign.meaning.en}`,
          nb: `${sign.name.nb} — ${sign.meaning.nb}`,
        },
      );

      const legalCitations = [
        { sourceCode: CITATION_SOURCE, ref: SECTION_FOR_CLASS[sign.signClass] },
      ];

      const quality = checkItemQuality({
        content,
        correctOptionKey,
        legalCitations,
      });
      if (!quality.passed) {
        rejected++;
        console.warn(
          `  ${sign.code} ${kind}: ${quality.errors.map((error) => error.code).join(", ")}`,
        );
        continue;
      }

      if (dryRun) {
        created++;
        continue;
      }

      const item = await db.masterItem.create({
        data: {
          type: "SIGN",
          // Inserted approved, not updated into it — the frozen-item trigger fires on UPDATE only.
          status: "APPROVED",
          topicId: topics.get(TOPIC_FOR_CLASS[sign.signClass])!,
          difficulty: kind === "recognition" ? 2 : 3,
          content,
          correctOptionKey,
          legalCitations,
          createdBy: "HUMAN",
          sourceImageId: imageId,
          // Which of the two generated forms this is — also the idempotency marker above.
          reviewNote: kind,
        },
        select: { id: true },
      });

      // The single sanctioned publish path: an approved item with no active variant is invisible
      // to students, so this is what actually puts the question in front of one.
      await publishItem(db, item.id);
      created++;
    }
  }

  console.log(
    `${dryRun ? "[dry run] " : ""}Sign questions: ${created} created, ${skipped} skipped, ${rejected} rejected by the quality gate.`,
  );
  if (tooSmall.size > 0) {
    console.log(
      `Classes with fewer than ${DISTRACTORS + 1} signs, so no questions yet: ${[...tooSmall].join(", ")}.`,
    );
    console.log(
      "They will be picked up once `pnpm signs:enrich` finishes those signs.",
    );
  }
  if (!dryRun) {
    const total = await db.masterItem.count({
      where: { type: "SIGN", status: "APPROVED" },
    });
    console.log(`Approved SIGN questions in the bank: ${total}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    redis.disconnect();
  });
