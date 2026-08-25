import type { AiProviderKind } from "@prisma/client";
import { anthropicAdapter } from "./anthropic";
import { googleAdapter } from "./google";
import { openAiCompatibleAdapter } from "./openai-compatible";
import type { ProviderAdapter } from "./types";

/** Adapter per provider family (spec-05). Adding a family is a new entry here, nothing else. */
const ADAPTERS: Record<AiProviderKind, ProviderAdapter> = {
  GOOGLE: googleAdapter,
  ANTHROPIC: anthropicAdapter,
  OPENAI_COMPATIBLE: openAiCompatibleAdapter,
};

export function adapterFor(kind: AiProviderKind): ProviderAdapter {
  return ADAPTERS[kind];
}

export * from "./types";
