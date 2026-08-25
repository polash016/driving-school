/**
 * Fill in what the theory book does not contain: each sign's meaning, and its Norwegian.
 *
 *   pnpm signs:enrich [--force] [--limit N] [--concurrency N]
 *
 * `pnpm signs:extract` recovers an English NAME per sign and nothing more. A sign test that can
 * only ask "what is this called?" is a vocabulary drill; asking what a sign *means* is the thing
 * students are actually examined on. So each sign is sent to the vision model together with its
 * own graphic — showing the model the sign is markedly better than describing it — and comes back
 * with a bilingual name and meaning.
 *
 * Everything it writes is a DRAFT. Rows stay `provisional: true` and land in /admin/signs for a
 * person to confirm. Norwegian in particular is read by native speakers and is not shippable on
 * the model's say-so.
 *
 * Resumable and idempotent: a sign that already has a meaning is skipped, and the manifest is
 * flushed after every sign, so an interrupted run costs only what it had not yet reached.
 * Re-run with --force to redraft everything.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { aiJson } from "../src/server/ai/client";
import { signMeaningPrompt } from "../src/server/ai/prompts/signs";
import { search } from "../src/server/services/kb/search";
import { redis } from "../src/server/redis";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);

const MANIFEST = join(process.cwd(), "prisma", "data", "signs.json");
const SIGNS_DIR = join(process.cwd(), "public", "signs");
/** Sign graphics are the authority on Norwegian sign law; only this source is worth retrieving. */
const SIGN_REGULATION = "skiltforskriften";

const db = new PrismaClient();

const draftSchema = z.object({
  nameEn: z.string().min(1).max(160),
  nameNb: z.string().min(1).max(160),
  meaningEn: z.string().min(10).max(400),
  meaningNb: z.string().min(10).max(400),
});

type Sign = {
  code: string;
  signClass: string;
  file: string;
  name: { en: string; nb?: string };
  meaning?: { en: string; nb: string };
  [key: string]: unknown;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Retry with exponential backoff.
 *
 * Free and low-tier provider plans meter this kind of bulk pass hard, and a 429 is a "come back
 * shortly", not a failure — treating it as one abandoned 249 of 287 signs on the first run and
 * would have left the registry looking like the model could not do the job.
 */
async function withBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait =
        Math.min(60_000, 2_000 * 2 ** (attempt - 1)) +
        Math.floor(Math.random() * 1_000);
      console.warn(
        `  ${label}: attempt ${attempt} failed, retrying in ${Math.round(wait / 1000)}s`,
      );
      await sleep(wait);
    }
  }
}

const flag = (name: string) => process.argv.includes(`--${name}`);
function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function draft(sign: Sign, groundable: boolean): Promise<void> {
  const bytes = await readFile(join(SIGNS_DIR, sign.file));

  // Only retrieve when a sign regulation is actually loaded. Searching a knowledge base that holds
  // nothing about signs would spend an embedding call per sign to add nothing to the prompt.
  let legalExcerpts = "";
  if (groundable) {
    const { hits } = await search(db, { query: sign.name.en, limit: 3 });
    legalExcerpts = hits
      .filter((hit) => hit.sourceCode === SIGN_REGULATION)
      .map((hit) => `${hit.ref}: ${hit.text}`)
      .join("\n---\n");
  }

  const { data } = await withBackoff(sign.code, () =>
    aiJson({
      task: "vision",
      prompt: signMeaningPrompt,
      vars: { nameEn: sign.name.en, signClass: sign.signClass, legalExcerpts },
      schema: draftSchema,
      userContent: [
        { type: "text", text: "Here is the sign:" },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${bytes.toString("base64")}`,
          },
        },
      ],
      temperature: 0.2,
    }),
  );

  sign.name = { en: data.nameEn, nb: data.nameNb };
  sign.meaning = { en: data.meaningEn, nb: data.meaningNb };
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST}. Run: pnpm signs:extract`);
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as {
    _readme?: string[];
    signs: Sign[];
  };
  const force = flag("force");
  // Low by default: this is a bulk pass against a metered API, and finishing in twelve minutes
  // without tripping the quota beats finishing in three and dropping most of the work.
  const concurrency = option("concurrency", 2);
  const pace = option("pace", 1_200);

  const pending = manifest.signs.filter(
    (s) => force || !s.meaning || !s.name.nb,
  );
  const todo = pending.slice(0, option("limit", pending.length));
  if (todo.length === 0) {
    console.log(
      `Nothing to do — all ${manifest.signs.length} signs already drafted.`,
    );
    console.log("Re-run with --force to redraft.");
    return;
  }

  const groundable =
    (await db.kbSource.count({ where: { code: SIGN_REGULATION } })) > 0;
  console.log(
    `Drafting ${todo.length} of ${manifest.signs.length} signs ` +
      `(concurrency ${concurrency}, ${groundable ? "grounded in " + SIGN_REGULATION : "no sign regulation in the KB — name + graphic only"}).`,
  );

  let done = 0;
  let failed = 0;
  const queue = [...todo];
  const save = () =>
    writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let sign = queue.shift(); sign; sign = queue.shift()) {
        try {
          await draft(sign, groundable);
          // Flush per sign: an interrupted run should never cost work it already paid for.
          await save();
          done++;
          await sleep(pace);
        } catch (error) {
          failed++;
          console.error(
            `  ${sign.code} (${sign.name.en}): ${error instanceof Error ? error.message : error}`,
          );
        }
        if ((done + failed) % 25 === 0) {
          console.log(
            `  ${done + failed}/${todo.length} — ${done} drafted, ${failed} failed`,
          );
        }
      }
    }),
  );

  await save();
  console.log(`\nDrafted ${done}, failed ${failed}.`);
  const remaining = manifest.signs.filter(
    (s) => !s.meaning || !s.name.nb,
  ).length;
  if (remaining > 0) {
    console.log(
      `${remaining} sign(s) still incomplete — re-run to pick them up.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("All signs have a bilingual name and meaning.");
  console.log("Next: pnpm db:seed-signs && pnpm signs:questions");
  console.log(
    "Then review the drafts in /admin/signs — every row is still marked provisional.",
  );
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
