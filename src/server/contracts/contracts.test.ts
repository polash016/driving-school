import {
  AttemptMode,
  AttemptStatus,
  CitationType,
  FactType,
  ImageStatus,
  ItemStatus,
  ItemType,
  KbSourceKind,
  Provenance,
  QuizMode,
  Role,
  SignClass,
  VariantSource,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  attemptModeSchema,
  attemptStatusSchema,
  citationTypeSchema,
  factTypeSchema,
  imageStatusSchema,
  itemStatusSchema,
  itemTypeSchema,
  kbSourceKindSchema,
  provenanceSchema,
  quizModeSchema,
  roleSchema,
  signClassSchema,
  variantSourceSchema,
} from "./models";

// Contract enums must stay in lockstep with Prisma enums — a drifted enum
// silently breaks API validation, so this fails loudly instead.
const pairs: Array<[string, Record<string, string>, { options: string[] }]> = [
  ["Role", Role, roleSchema],
  ["QuizMode", QuizMode, quizModeSchema],
  ["ItemType", ItemType, itemTypeSchema],
  ["ItemStatus", ItemStatus, itemStatusSchema],
  ["Provenance", Provenance, provenanceSchema],
  ["VariantSource", VariantSource, variantSourceSchema],
  ["AttemptMode", AttemptMode, attemptModeSchema],
  ["AttemptStatus", AttemptStatus, attemptStatusSchema],
  ["ImageStatus", ImageStatus, imageStatusSchema],
  ["SignClass", SignClass, signClassSchema],
  ["CitationType", CitationType, citationTypeSchema],
  ["KbSourceKind", KbSourceKind, kbSourceKindSchema],
  ["FactType", FactType, factTypeSchema],
];

describe("contract enums mirror Prisma enums", () => {
  it.each(pairs.map(([name, p, s]) => [name, p, s] as const))(
    "%s",
    (_name, prismaEnum, zodEnum) => {
      expect([...zodEnum.options].sort()).toEqual(
        Object.values(prismaEnum).sort(),
      );
    },
  );
});
