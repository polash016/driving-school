"use server";

import { redirect } from "@/i18n/navigation";

import { requireUser } from "@/server/auth/require-user";
import type { ActionResult } from "@/server/contracts/common";
import type {
  AnswerAck,
  ClientAttempt,
  PracticeAnswerResult,
} from "@/server/contracts/quiz";
import { toActionError } from "@/server/http/action-result";
import { attemptService } from "@/server/services/assessment";
import { evaluateGuarantee } from "@/server/services/assessment/pass-guarantee";
import { db } from "@/server/db";
import type { AppLocale } from "../../../../../config/school.config";

/**
 * The student's quiz endpoints (spec-07 integration).
 *
 * Thin by design: parse, authorise, hand to the engine. Every payload that reaches the browser is
 * built by the engine's serializer, which structurally cannot carry the correct answer before
 * submission — that invariant lives in the contracts, not in this file's good intentions.
 */

export async function startQuizAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const locale = String(formData.get("locale") ?? "en") as AppLocale;
  const mode = String(formData.get("mode") ?? "PRACTICE");

  let attemptId: string;
  try {
    const attempt = await attemptService.startQuiz(user.id, {
      mode,
      locale,
      ...(mode === "EXAM"
        ? { licenseClassCode: String(formData.get("licenseClassCode") ?? "B") }
        : {}),
      ...(mode !== "EXAM"
        ? { questionCount: Number(formData.get("questionCount") ?? 10) }
        : {}),
      ...(formData.get("topicSlug")
        ? { topicSlugs: [String(formData.get("topicSlug"))] }
        : {}),
      // What separates the Image Quiz tile from the Theory Test tile — same engine, one filter.
      // Parsed by the contract, so an unrecognised value is rejected rather than silently ignored.
      ...(formData.get("itemType")
        ? { itemType: String(formData.get("itemType")) }
        : {}),
    });
    attemptId = attempt.id;
  } catch (error) {
    // A thin pool is a normal state for a new school, not a crash: say what is missing rather
    // than dropping the student on a generic error page.
    const mapped = toActionError(error);
    if (mapped.code === "EXAM_STATE") {
      return { ...mapped, messageKey: "quiz.errors.noQuestions" };
    }
    if (mapped.code === "INTERNAL" && mode === "EXAM") {
      return { ...mapped, messageKey: "quiz.errors.examPoolTooSmall" };
    }
    return mapped;
  }

  redirect({ href: `/quiz/${attemptId}`, locale });
  return { ok: true };
}

export async function answerAction(
  _prev: ActionResult<PracticeAnswerResult | AnswerAck> | undefined,
  formData: FormData,
): Promise<ActionResult<PracticeAnswerResult | AnswerAck>> {
  const user = await requireUser();
  try {
    const result = await attemptService.answer(user.id, {
      attemptId: String(formData.get("attemptId") ?? ""),
      position: Number(formData.get("position") ?? 1),
      optionKey: String(formData.get("optionKey") ?? ""),
      locale: String(formData.get("locale") ?? "en"),
    });
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * The feedback for a question the student already answered — so navigating back, or refreshing,
 * shows the explanation again rather than an empty card. Reveals nothing new: an answer cannot be
 * changed once given, and EXAM mode is refused outright.
 */
export async function revealAction(
  _prev: ActionResult<PracticeAnswerResult> | undefined,
  formData: FormData,
): Promise<ActionResult<PracticeAnswerResult>> {
  const user = await requireUser();
  try {
    const result = await attemptService.revealAnswered(user.id, {
      attemptId: String(formData.get("attemptId") ?? ""),
      position: Number(formData.get("position") ?? 1),
      locale: String(formData.get("locale") ?? "en"),
    });
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function flagAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await attemptService.setFlag(user.id, {
    attemptId: String(formData.get("attemptId") ?? ""),
    position: Number(formData.get("position") ?? 1),
    flagged: formData.get("flagged") === "true",
  });
}

export async function submitAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const locale = String(formData.get("locale") ?? "en") as AppLocale;
  const attemptId = String(formData.get("attemptId") ?? "");

  await attemptService.submit(user.id, { attemptId, locale });
  // The paper and the score live in the student's record — one place, not two renderings.
  redirect({ href: `/account/history/${attemptId}`, locale });
}

/** Re-reads the attempt as the engine serves it (no correctness pre-submit). */
export async function refreshAttempt(
  attemptId: string,
  locale: AppLocale,
): Promise<ClientAttempt> {
  const user = await requireUser();
  return attemptService.serveAttempt(user.id, { attemptId, locale });
}

/**
 * Start a test the student configured: clock on or off, how many questions, which categories.
 *
 * Eligibility for the pass guarantee is decided HERE, from the validated configuration — the
 * setup screen explains the rule, it does not get to assert the answer. The decision is stored on
 * the attempt and frozen with the result.
 */
export async function startConfiguredQuizAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const locale = String(formData.get("locale") ?? "en") as AppLocale;

  const topicSlugs = formData.getAll("topicSlugs").map(String).filter(Boolean);
  const questionCount = Math.min(
    90,
    Math.max(1, Number(formData.get("questionCount") ?? 45)),
  );
  const timed = formData.get("timed") === "on";

  const totalTopicCount = await db.topic.count({
    where: { parentId: null, isActive: true, deletedAt: null },
  });
  if (topicSlugs.length === 0) {
    return {
      ok: false,
      code: "VALIDATION",
      messageKey: "quiz.setup.errors.noCategories",
    };
  }

  const guarantee = evaluateGuarantee({
    questionCount,
    selectedTopicCount: topicSlugs.length,
    totalTopicCount,
  });

  let attemptId: string;
  try {
    const attempt = await attemptService.startQuiz(
      user.id,
      { mode: "TOPIC", locale, topicSlugs, questionCount, timed },
      {
        countsTowardGuarantee: guarantee.counts,
        setupSnapshot: {
          timed,
          questionCount,
          topicSlugs,
          totalTopicCount,
          countsTowardGuarantee: guarantee.counts,
          reasons: guarantee.reasons,
        },
      },
    );
    attemptId = attempt.id;
  } catch (error) {
    const mapped = toActionError(error);
    return mapped.code === "EXAM_STATE"
      ? { ...mapped, messageKey: "quiz.errors.noQuestions" }
      : mapped;
  }

  redirect({ href: `/quiz/${attemptId}`, locale });
  return { ok: true };
}
