/**
 * Shorten the question bank in place, without any student ever reading English (spec-22).
 *
 *   pnpm qb:simplify signs                       # dry run: propose shorter sign meanings
 *   pnpm qb:simplify signs --apply               # write the registry + re-render sign questions
 *   pnpm qb:simplify text                        # dry run: propose shorter text/image questions
 *   pnpm qb:simplify text --apply                # translate, then swap, per item
 *   pnpm qb:simplify report --run <id>           # what a run proposed, and what it refused
 *   pnpm qb:simplify rollback --run <id>         # put every item in that run back
 *
 * Flags: --limit N, --item <id>, --include-recognition, --yes
 *
 * DRY RUN IS THE DEFAULT everywhere. A dry run makes AI calls (it must, to have something to
 * show you) but writes nothing to MasterItem, Sign or Translation — it only records proposals.
 *
 * The order that matters: a proposal is translated into EVERY language BEFORE its question is
 * swapped, and the swap writes content, variant and all translations in one transaction. That is
 * what makes the rewrite invisible: no student sees a stale translation, and none falls back to
 * English either.
 */
import { PrismaClient, type SignClass } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { redis } from "../src/server/redis";
import { schoolConfig } from "../config/school.config";
import { countWords } from "../src/lib/brevity";
import {
  loadPoolFingerprints,
  proposeSimplification,
  type QuestionContent,
  type SimplifiableItem,
} from "../src/server/services/question-bank/simplify";
import {
  distinctnessDelta,
  loadSigns,
  proposeSignSimplification,
  rerenderSignQuestion,
  type SignRow,
} from "../src/server/services/question-bank/sign-simplify";
import {
  shadowTranslateAll,
  targetLanguages,
} from "../src/server/services/question-bank/shadow-translate";
import {
  contentFingerprint,
  rewriteApprovedItemInPlace,
  rollbackRewrite,
} from "../src/server/services/question-bank/rewrite";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
  ".env",
);
const db = new PrismaClient();

const argv = process.argv.slice(2);
const command = argv[0] ?? "";
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const APPLY = flag("apply");
const LIMIT = Number(option("limit", "0")) || 0;

function words(text: string, locale = "en"): number {
  return countWords(text, locale);
}

/** Longest option in a question, the number that actually hurts on a phone. */
function worstOption(content: QuestionContent): number {
  return Math.max(0, ...content.en.options.map((o) => words(o.text)));
}

function table(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  for (const row of rows) {
    console.log(row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  "));
  }
}

// ───────────────────────────────────────────────────────────────── signs ──

async function runSigns(runId: string): Promise<void> {
  const signs = await loadSigns(db);
  const scope = LIMIT > 0 ? signs.slice(0, LIMIT) : signs;
  console.log(
    `${signs.length} signs in the registry; proposing for ${scope.length}.\n`,
  );

  const byClass = new Map<SignClass, SignRow[]>();
  for (const sign of signs) {
    byClass.set(sign.signClass, [...(byClass.get(sign.signClass) ?? []), sign]);
  }

  const accepted = new Map<string, SignRow>();
  const rows: string[][] = [["code", "before", "after", "verdict", "new meaning"]];
  let refused = 0;
  let unchanged = 0;

  for (const [index, sign] of scope.entries()) {
    const siblings = (byClass.get(sign.signClass) ?? []).filter(
      (s) => s.id !== sign.id,
    );
    let proposal;
    try {
      proposal = await proposeSignSimplification(sign, siblings);
    } catch (error) {
      refused++;
      rows.push([sign.code, String(words(sign.meaning.en)), "-", "ERROR", String(error).slice(0, 60)]);
      continue;
    }

    if (proposal.verdict === "ACCEPT" && proposal.proposed) {
      accepted.set(sign.id, { ...sign, ...proposal.proposed });
      rows.push([
        sign.code,
        String(words(sign.meaning.en)),
        String(words(proposal.proposed.meaning.en)),
        "ok",
        proposal.proposed.meaning.en.slice(0, 54),
      ]);
    } else if (proposal.verdict === "UNCHANGED") {
      unchanged++;
      rows.push([sign.code, String(words(sign.meaning.en)), "-", "kept", "(model declined)"]);
    } else {
      refused++;
      rows.push([sign.code, String(words(sign.meaning.en)), "-", "refused", proposal.findings.join(",")]);
    }

    await db.simplificationProposal.upsert({
      where: { runId_signId: { runId, signId: sign.id } },
      create: {
        runId,
        signId: sign.id,
        proposed: (proposal.proposed ?? {}) as never,
        previous: proposal.previous as never,
        expectedFingerprint: contentFingerprint(proposal.previous),
        status: proposal.verdict === "ACCEPT" ? "PROPOSED" : "REFUSED",
        findings: proposal.findings,
        modelVersion: proposal.modelVersion,
        promptVersion: proposal.promptVersion,
      },
      update: {},
      select: { id: true },
    });

    if ((index + 1) % 25 === 0) {
      console.log(`  …${index + 1}/${scope.length}`);
    }
  }

  table(rows);
  console.log(
    `\naccepted ${accepted.size} · kept ${unchanged} · refused ${refused}`,
  );

  // THE set-level gate. Runs over the whole proposed registry before any question is touched,
  // because "two signs in a class now say the same thing" is a property of the set, not a row.
  const merged = signs.map((sign) => {
    const next = accepted.get(sign.id);
    return {
      code: sign.code,
      signClass: sign.signClass,
      meaningEn: (next ?? sign).meaning.en,
    };
  });
  const current = signs.map((sign) => ({
    code: sign.code,
    signClass: sign.signClass,
    meaningEn: sign.meaning.en,
  }));
  const { introduced, preExisting } = distinctnessDelta(current, merged);

  if (preExisting.length > 0) {
    console.log("\nregistry faults that PREDATE this campaign (reported, not blocking):");
    for (const problem of preExisting) {
      console.log(
        `  ${problem.signClass}: ${problem.distinct} distinct of ${problem.total}` +
          (problem.duplicates.length ? ` · duplicates: ${problem.duplicates.join(", ")}` : ""),
      );
    }
  }
  if (introduced.length > 0) {
    console.log("\n⚠ THIS REWRITE would make sign questions ungradeable:");
    for (const problem of introduced) {
      console.log(
        `  ${problem.signClass}: ${problem.distinct} distinct of ${problem.total}` +
          (problem.duplicates.length ? ` · duplicates: ${problem.duplicates.join(", ")}` : ""),
      );
    }
    console.log("\nFix those meanings by hand in /admin/signs, then re-run. Nothing was applied.");
    return;
  }
  console.log("class distinctness: OK (this rewrite introduces no new collisions)");

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.  run id: ${runId}`);
    return;
  }
  await applySigns(runId, signs, accepted);
}

/**
 * Write the registry, then re-render the questions built from it.
 *
 * Registry first and questions second, because every meaning is a potential DISTRACTOR in every
 * other question of its class — re-rendering before the whole registry is settled would bake in
 * half-shortened distractors.
 */
async function applySigns(
  runId: string,
  allSigns: SignRow[],
  accepted: Map<string, SignRow>,
): Promise<void> {
  console.log(`\nApplying ${accepted.size} sign meanings…`);
  for (const [signId, next] of accepted) {
    await db.sign.update({
      where: { id: signId },
      data: { name: next.name as never, meaning: next.meaning as never },
      select: { id: true },
    });
  }

  // The inverse index is built from the OLD text, which is what the questions still contain.
  const indexEn = new Map<string, string>();
  const indexNb = new Map<string, string>();
  for (const sign of allSigns) {
    const next = accepted.get(sign.id) ?? sign;
    indexEn.set(sign.meaning.en.trim().toLowerCase(), next.meaning.en);
    indexNb.set(sign.meaning.nb.trim().toLowerCase(), next.meaning.nb);
    // Names are unchanged, but recognition questions' options are names: mapping them to
    // themselves lets the same code path serve both kinds.
    indexEn.set(sign.name.en.trim().toLowerCase(), next.name.en);
    indexNb.set(sign.name.nb.trim().toLowerCase(), next.name.nb);
  }

  const kinds = flag("include-recognition")
    ? ["meaning", "recognition"]
    : ["meaning"];
  console.log(`Re-rendering sign questions of kind: ${kinds.join(", ")}`);
  if (!flag("include-recognition")) {
    console.log(
      "  (recognition questions offer sign NAMES — median 3 words, already inside budget.\n" +
        "   Their options do not change; only the explanation embeds a meaning. Use\n" +
        "   --include-recognition to rewrite those too, at ~2x the translation cost.)",
    );
  }

  const items = await db.masterItem.findMany({
    where: {
      type: "SIGN",
      status: "APPROVED",
      deletedAt: null,
      reviewNote: { in: kinds },
    },
    select: {
      id: true,
      version: true,
      content: true,
      correctOptionKey: true,
      reviewNote: true,
      sourceImage: { select: { licenseAttestation: true } },
    },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  });

  const byCode = new Map(allSigns.map((s) => [s.code, accepted.get(s.id) ?? s]));
  const languages = await targetLanguages(db);
  await swapAll(runId, items, byCode, indexEn, indexNb, languages);
}

async function swapAll(
  runId: string,
  items: Array<{
    id: string;
    version: number;
    content: unknown;
    correctOptionKey: string | null;
    reviewNote: string | null;
    sourceImage: { licenseAttestation: unknown } | null;
  }>,
  byCode: Map<string, SignRow>,
  indexEn: Map<string, string>,
  indexNb: Map<string, string>,
  languages: Awaited<ReturnType<typeof targetLanguages>>,
): Promise<void> {
  let swapped = 0;
  let held = 0;

  for (const item of items) {
    const code = (item.sourceImage?.licenseAttestation as { signCode?: string } | null)?.signCode;
    const subject = code ? byCode.get(code) : undefined;
    if (!subject || !item.correctOptionKey) {
      held++;
      continue;
    }

    const rerendered = rerenderSignQuestion({
      itemId: item.id,
      kind: item.reviewNote === "recognition" ? "recognition" : "meaning",
      content: item.content as QuestionContent,
      subject,
      indexEn,
      indexNb,
    });
    if (!rerendered.content) {
      held++;
      console.log(`  hold ${item.id}: ${rerendered.findings.join(", ")}`);
      continue;
    }

    // Translate FIRST, into every language, then swap everything together.
    const shadow = await shadowTranslateAll(db, languages, {
      itemId: item.id,
      proposed: rerendered.content,
      correctOptionKey: item.correctOptionKey,
      label: `sign ${code}`,
    });
    if (!shadow.ready) {
      held++;
      console.log(
        `  hold ${item.id}: translation not ready — ` +
          shadow.failures.map((f) => `${f.locale}(${f.reason})`).join(", "),
      );
      continue;
    }

    await rewriteApprovedItemInPlace(db, {
      itemId: item.id,
      newContent: rerendered.content as never,
      expectedVersion: item.version,
      expectedFingerprint: contentFingerprint(item.content),
      translations: shadow.translations,
      runId,
      actorId: await adminId(),
    });
    swapped++;
    if (swapped % 10 === 0) console.log(`  …swapped ${swapped}`);
  }

  console.log(`\nswapped ${swapped} · held ${held}`);
}

// ────────────────────────────────────────────────────────── text / image ──

async function runText(runId: string): Promise<void> {
  const items = await db.masterItem.findMany({
    where: {
      type: { in: ["TEXT", "IMAGE"] },
      status: "APPROVED",
      deletedAt: null,
      ...(option("item") ? { id: option("item") } : {}),
    },
    select: {
      id: true,
      type: true,
      version: true,
      content: true,
      correctOptionKey: true,
      legalCitations: true,
      difficulty: true,
      sourceImageId: true,
    },
    orderBy: { id: "asc" },
    ...(LIMIT > 0 ? { take: LIMIT } : {}),
  });
  console.log(`${items.length} approved text/image questions in scope.\n`);

  const pool = await loadPoolFingerprints(db);
  const languages = await targetLanguages(db);
  console.log(
    `target languages: ${languages.map((l) => l.code).join(", ") || "(none)"}\n`,
  );

  const rows: string[][] = [["id", "stem", "worst opt", "verdict", "detail"]];
  let accepted = 0;
  let refused = 0;
  let unchanged = 0;
  let swapped = 0;

  for (const item of items) {
    const before = item.content as unknown as QuestionContent;

    // One item must never abort the campaign. A provider hiccup, a contract-validation failure or a
    // rate limit is a fact about that call, not about the other 147 questions — and a run that dies
    // on item 3 of 148 wastes every proposal before it.
    let proposal;
    try {
      proposal = await proposeSimplification(
        db,
        item as unknown as SimplifiableItem,
        { poolFingerprints: pool },
      );
    } catch (error) {
      refused++;
      const detail =
        error instanceof Error ? error.message.slice(0, 40) : String(error).slice(0, 40);
      rows.push([
        item.id.slice(-6),
        `${words(before.en.stem)}`,
        `${worstOption(before)}`,
        "ERROR",
        detail,
      ]);
      continue;
    }

    if (proposal.verdict === "UNCHANGED") {
      unchanged++;
      rows.push([item.id.slice(-6), `${words(before.en.stem)}`, `${worstOption(before)}`, "kept", proposal.findings.join(",") || "model declined"]);
      continue;
    }
    if (proposal.verdict === "REFUSE" || !proposal.proposed) {
      refused++;
      // Persist refusals too. A campaign you cannot audit after the fact is a campaign you cannot
      // trust: without the row there is no way to ask later WHY an item was skipped, and the first
      // real run produced thirteen identical refusals whose cause was invisible for exactly this
      // reason.
      await db.simplificationProposal.upsert({
        where: { runId_masterItemId: { runId, masterItemId: item.id } },
        create: {
          runId,
          masterItemId: item.id,
          proposed: {},
          previous: proposal.previous as never,
          expectedVersion: proposal.expectedVersion,
          expectedFingerprint: proposal.expectedFingerprint,
          status: "REFUSED",
          findings: proposal.findings,
          checks: proposal.checks as never,
          modelVersion: proposal.modelVersion,
          promptVersion: proposal.promptVersion,
          verifierModel: proposal.verifierModel,
        },
        update: { status: "REFUSED", findings: proposal.findings, checks: proposal.checks as never },
        select: { id: true },
      });
      const drift = (proposal.checks as { drift?: string[] } | undefined)?.drift;
      rows.push([
        item.id.slice(-6),
        `${words(before.en.stem)}`,
        `${worstOption(before)}`,
        "refused",
        drift?.length
          ? `${proposal.findings.join(",")} · ${drift[0]!.slice(0, 60)}`
          : proposal.findings.join(","),
      ]);
      continue;
    }

    accepted++;
    if (proposal.newFingerprint) pool.set(proposal.newFingerprint, item.id);
    rows.push([
      item.id.slice(-6),
      `${words(before.en.stem)}→${words(proposal.proposed.en.stem)}`,
      `${worstOption(before)}→${worstOption(proposal.proposed)}`,
      "ok",
      proposal.proposed.en.stem.slice(0, 50),
    ]);

    await db.simplificationProposal.upsert({
      where: { runId_masterItemId: { runId, masterItemId: item.id } },
      create: {
        runId,
        masterItemId: item.id,
        proposed: proposal.proposed as never,
        previous: proposal.previous as never,
        expectedVersion: proposal.expectedVersion,
        expectedFingerprint: proposal.expectedFingerprint,
        status: "PROPOSED",
        findings: [],
        checks: proposal.checks as never,
        modelVersion: proposal.modelVersion,
        promptVersion: proposal.promptVersion,
        verifierModel: proposal.verifierModel,
      },
      update: {},
      select: { id: true },
    });

    if (!APPLY) continue;

    const shadow = await shadowTranslateAll(db, languages, {
      itemId: item.id,
      proposed: proposal.proposed,
      correctOptionKey: item.correctOptionKey!,
      label: `q ${item.id.slice(-6)}`,
    });
    if (!shadow.ready) {
      console.log(
        `  hold ${item.id.slice(-6)}: ` +
          shadow.failures.map((f) => `${f.locale}(${f.reason})`).join(", "),
      );
      continue;
    }
    await rewriteApprovedItemInPlace(db, {
      itemId: item.id,
      newContent: proposal.proposed as never,
      expectedVersion: proposal.expectedVersion,
      expectedFingerprint: proposal.expectedFingerprint,
      translations: shadow.translations,
      runId,
      actorId: await adminId(),
      stemEmbedding: proposal.stemEmbedding,
    });
    swapped++;
  }

  table(rows);
  console.log(
    `\naccepted ${accepted} · kept ${unchanged} · refused ${refused}` +
      (APPLY ? ` · swapped ${swapped}` : ""),
  );
  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.  run id: ${runId}`);
  }
}

// ──────────────────────────────────────────────────────── report / undo ──

/**
 * Every accepted rewrite, before and after, for a human to read.
 *
 * The automated gates catch mechanical faults — a moved key, a dropped number, collapsed
 * distractors, a duplicate. They do NOT catch a shortening that stays legally true while testing
 * something broader: one observed rewrite dropped "where traffic is not regulated by police or
 * traffic lights" from a crossing question, which every gate passed because the answer is still
 * correct in the general case. Only a person reading the pair catches that, which is why this
 * exists and why it should be read before --apply.
 */
async function runDiffs(runId: string): Promise<void> {
  const proposals = await db.simplificationProposal.findMany({
    where: { runId, status: "PROPOSED", masterItemId: { not: null } },
    select: { masterItemId: true, previous: true, proposed: true },
    orderBy: { createdAt: "asc" },
  });
  if (proposals.length === 0) {
    console.log(`No accepted proposals in run ${runId}.`);
    return;
  }

  const side = (v: unknown) => (v as QuestionContent | null)?.en;
  let scopeSuspects = 0;

  for (const [index, p] of proposals.entries()) {
    const before = side(p.previous);
    const after = side(p.proposed);
    if (!before || !after) continue;

    console.log(`
${"─".repeat(78)}`);
    console.log(`${index + 1}/${proposals.length}  ${p.masterItemId?.slice(-8)}`);
    console.log(`  STEM  ${words(before.stem)}w → ${words(after.stem)}w`);
    console.log(`    -   ${before.stem}`);
    console.log(`    +   ${after.stem}`);

    // Words the original stem carried that the rewrite dropped. A dropped qualifier is how a
    // question silently becomes a broader question, so they are surfaced rather than counted.
    const stop = new Set(["a","an","the","is","are","you","your","to","of","and","or","in","on","at","it","that","this","what","must","do","if","for","with","from","be","as","not","no"]);
    const beforeWords = new Set(before.stem.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const afterWords = new Set(after.stem.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const dropped = [...beforeWords].filter((w) => !afterWords.has(w) && !stop.has(w) && w.length > 3);
    if (dropped.length > 0) {
      console.log(`    !   dropped from stem: ${dropped.join(", ")}`);
      scopeSuspects++;
    }

    for (const option of after.options) {
      const was = before.options.find((o) => o.key === option.key);
      if (!was) continue;
      if (was.text !== option.text) {
        console.log(`  OPT ${option.key}  ${words(was.text)}w → ${words(option.text)}w`);
        console.log(`    -   ${was.text}`);
        console.log(`    +   ${option.text}`);
      }
    }
    console.log(`  EXPL  ${after.explanation}`);
  }

  console.log(`
${"═".repeat(78)}`);
  console.log(`${proposals.length} accepted · ${scopeSuspects} dropped words from the stem — read those closely`);
  console.log("A dropped qualifier ('not regulated by lights', 'private', 'unmarked') changes what");
  console.log("the question asks even when the answer stays right. No gate can catch that.");
}

async function runReport(runId: string): Promise<void> {
  const proposals = await db.simplificationProposal.findMany({
    where: { runId },
    select: {
      masterItemId: true,
      signId: true,
      status: true,
      findings: true,
      proposed: true,
      previous: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const rows: string[][] = [["target", "status", "findings"]];
  for (const p of proposals) {
    rows.push([
      (p.masterItemId ?? p.signId ?? "?").slice(-8),
      p.status,
      p.findings.join(",") || "-",
    ]);
  }
  table(rows);
  console.log(`\n${proposals.length} proposals in run ${runId}`);
}

async function runRollback(runId: string): Promise<void> {
  const audits = await db.auditLog.findMany({
    where: { action: "item.simplified" },
    select: { entityId: true, meta: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const mine = audits.filter(
    (a) => (a.meta as { runId?: string } | null)?.runId === runId,
  );
  if (mine.length === 0) {
    console.log(`No applied items found for run ${runId}.`);
    return;
  }
  if (!flag("yes")) {
    console.log(`Would roll back ${mine.length} items from run ${runId}. Re-run with --yes.`);
    return;
  }
  for (const audit of mine) {
    const meta = audit.meta as {
      previousContent: unknown;
      versionFrom: number;
      previousTranslations?: Array<{
        locale: string;
        value: unknown;
        status: string;
        sourceHash: string;
        qaFlags: string[];
        modelVersion: string | null;
        promptVersion: string | null;
        providerLabel: string | null;
      }>;
    };
    // The translations the item had BEFORE the rewrite. Restoring the English without these would
    // leave the new short translations attached to the old long question.
    const previous = (meta.previousTranslations ?? []).map((t) => ({
      locale: t.locale,
      value: t.value as never,
      status: t.status as never,
      sourceHash: t.sourceHash,
      qaFlags: t.qaFlags ?? [],
      modelVersion: t.modelVersion,
      promptVersion: t.promptVersion,
      providerLabel: t.providerLabel,
    }));
    if (meta.previousTranslations === undefined) {
      console.log(
        `  ⚠ ${audit.entityId}: this item was rewritten before translation snapshots existed — ` +
          `its English will be restored but its translations cannot be. Re-run i18n sync for it.`,
      );
    }
    await rollbackRewrite(db, {
      itemId: audit.entityId!,
      previousContent: meta.previousContent as never,
      versionFrom: meta.versionFrom,
      translations: previous,
      actorId: await adminId(),
      runId,
    });
  }
  console.log(`Rolled back ${mine.length} items.`);
}

let cachedAdminId: string | null = null;
async function adminId(): Promise<string> {
  if (cachedAdminId) return cachedAdminId;
  const admin = await db.user.findFirstOrThrow({
    where: { role: "ADMIN", deletedAt: null },
    select: { id: true },
  });
  cachedAdminId = admin.id;
  return admin.id;
}

async function main(): Promise<void> {
  const runId = option("run") ?? `simplify-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const brevity = schoolConfig.content.brevity;
  console.log(
    `budget: stem ≤ ${brevity.stemWords} · option ≤ ${brevity.optionWords} ` +
      `· sign meaning ≤ ${brevity.signMeaningWords} words\n`,
  );

  switch (command) {
    case "signs":
      return runSigns(runId);
    case "text":
      return runText(runId);
    case "report":
      return runReport(runId);
    case "diffs":
      return runDiffs(runId);
    case "rollback":
      return runRollback(runId);
    default:
      throw new Error(
        "Usage: pnpm qb:simplify <signs|text|report|diffs|rollback> [--apply] [--limit N] [--run <id>] [--include-recognition] [--yes]",
      );
  }
}

main()
  .catch((error) => {
    const meta = (error as { meta?: unknown }).meta;
    console.error(error instanceof Error ? error.message : error);
    if (meta) console.error(JSON.stringify(meta, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await redis.quit().catch(() => undefined);
  });
