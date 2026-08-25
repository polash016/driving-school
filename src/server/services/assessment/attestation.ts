import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";
import { gradeAttempt, type GradableQuestion } from "@/server/services/quiz/grading";

/**
 * Result attestation (spec-04b).
 *
 * A pass here decides whether a student may go on to the official test, so the mark must be
 * provable rather than merely stored. At submission we hash the whole record — every question as
 * served, the option order that student saw, their answer, and the grade — and keep the digest
 * on the attempt. Re-computing it later proves nothing was edited, and re-running the grader
 * over the same rows proves the score follows from the answers.
 *
 * The hash is integrity evidence, not a secret: it is a tamper *detector*, not a signature.
 * Signing it with a deployment key belongs with spec-12's security work if it is ever needed.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const ATTESTATION_VERSION = "v1";

export interface AttestationRecord {
  version: string;
  attemptId: string;
  userId: string;
  mode: string;
  seed: string;
  passMark: number | null;
  questionCount: number;
  submittedAt: string;
  correctCount: number;
  passed: boolean | null;
  questions: Array<{
    position: number;
    variantId: string;
    contentHash: string;
    optionOrder: string[];
    answered: string | null;
    correct: boolean | null;
  }>;
}

/** Canonical JSON — field order fixed, questions by position — so the digest is reproducible. */
export function hashAttestation(record: AttestationRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

async function buildRecord(db: Db, attemptId: string): Promise<AttestationRecord> {
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      userId: true,
      mode: true,
      seed: true,
      passMarkSnapshot: true,
      questionCountSnapshot: true,
      submittedAt: true,
      correctCount: true,
      passed: true,
      questions: {
        select: {
          position: true,
          variantId: true,
          optionOrder: true,
          answeredOptionKey: true,
          isCorrect: true,
          variant: { select: { contentHash: true } },
        },
        orderBy: { position: "asc" },
      },
    },
  });
  if (!attempt) throw new NotFoundError({ attemptId });

  return {
    version: ATTESTATION_VERSION,
    attemptId: attempt.id,
    userId: attempt.userId,
    mode: attempt.mode,
    seed: attempt.seed,
    passMark: attempt.passMarkSnapshot,
    questionCount: attempt.questionCountSnapshot,
    submittedAt: attempt.submittedAt?.toISOString() ?? "",
    correctCount: attempt.correctCount ?? 0,
    passed: attempt.passed,
    questions: attempt.questions.map((question) => ({
      position: question.position,
      variantId: question.variantId,
      contentHash: question.variant.contentHash,
      optionOrder: question.optionOrder as string[],
      answered: question.answeredOptionKey,
      correct: question.isCorrect,
    })),
  };
}

/**
 * Called at submission, inside the grading transaction and BEFORE the attempt's status closes —
 * the `attempt_result_final` trigger refuses to write it afterwards, which is the point.
 */
export async function attestAttempt(db: Db, attemptId: string): Promise<string> {
  const record = await buildRecord(db, attemptId);
  const resultHash = hashAttestation(record);
  await db.examAttempt.update({
    where: { id: attemptId },
    data: { resultHash, attestedAt: new Date() },
    select: { id: true },
  });
  return resultHash;
}

export interface VerificationResult {
  attemptId: string;
  /** The stored digest still matches the stored rows — nothing was edited after submission. */
  hashMatches: boolean;
  /** Re-running the grader over those rows reproduces the recorded score. */
  gradeReproduces: boolean;
  storedHash: string | null;
  computedHash: string;
  storedCorrectCount: number;
  recomputedCorrectCount: number;
  storedPassed: boolean | null;
  recomputedPassed: boolean | null;
  intact: boolean;
}

/**
 * Answers "is this mark real?" — the question a disputed result actually raises. Read-only: a
 * mismatch is reported, never repaired, because silently rewriting a result is the failure mode
 * this whole mechanism exists to make impossible.
 */
export async function verifyAttempt(
  db: PrismaClient,
  attemptId: string,
): Promise<VerificationResult> {
  const record = await buildRecord(db, attemptId);
  const computedHash = hashAttestation(record);

  const attempt = await db.examAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      resultHash: true,
      correctCount: true,
      passed: true,
      passMarkSnapshot: true,
      questions: {
        select: {
          position: true,
          topicId: true,
          answeredOptionKey: true,
          variant: { select: { correctOptionKey: true } },
        },
        orderBy: { position: "asc" },
      },
    },
  });

  const gradable: GradableQuestion[] = attempt.questions.map((question) => ({
    position: question.position,
    topicSlug: question.topicId,
    answeredOptionKey: question.answeredOptionKey,
    correctOptionKey: question.variant.correctOptionKey,
  }));
  const regraded = gradeAttempt(gradable, attempt.passMarkSnapshot);

  const hashMatches = attempt.resultHash !== null && attempt.resultHash === computedHash;
  const gradeReproduces =
    regraded.correctCount === (attempt.correctCount ?? 0) &&
    regraded.passed === attempt.passed;

  return {
    attemptId,
    hashMatches,
    gradeReproduces,
    storedHash: attempt.resultHash,
    computedHash,
    storedCorrectCount: attempt.correctCount ?? 0,
    recomputedCorrectCount: regraded.correctCount,
    storedPassed: attempt.passed,
    recomputedPassed: regraded.passed,
    intact: hashMatches && gradeReproduces,
  };
}
