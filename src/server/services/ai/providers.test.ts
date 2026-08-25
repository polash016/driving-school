import { describe, expect, it } from "vitest";
import { adapterFor, classify, ProviderError } from "@/server/ai/providers";
import { createProviderInputSchema, upsertRouteInputSchema } from "./providers";

/**
 * Spec-05: the routing rules that make free tiers usable, and the input contract that stops a
 * half-configured provider being saved.
 */
describe("provider configuration", () => {
  it("requires a base URL for an OpenAI-compatible provider", () => {
    // Without it we could not tell DeepSeek from Groq from a local Ollama.
    expect(() =>
      createProviderInputSchema.parse({
        kind: "OPENAI_COMPATIBLE",
        label: "DeepSeek",
        apiKey: "sk-test-12345678",
      }),
    ).toThrow();

    expect(() =>
      createProviderInputSchema.parse({
        kind: "OPENAI_COMPATIBLE",
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test-12345678",
      }),
    ).not.toThrow();
  });

  it("does not require a base URL for a native provider", () => {
    expect(() =>
      createProviderInputSchema.parse({
        kind: "GOOGLE",
        label: "Gemini",
        apiKey: "AIza-test-12345678",
      }),
    ).not.toThrow();
  });

  it("rejects an implausibly short key", () => {
    expect(() =>
      createProviderInputSchema.parse({
        kind: "ANTHROPIC",
        label: "Claude",
        apiKey: "short",
      }),
    ).toThrow();
  });

  it("orders routes by explicit priority", () => {
    const route = upsertRouteInputSchema.parse({
      task: "GENERATION",
      providerId: "p1",
      model: "gemini-2.0-flash",
    });
    expect(route.priority).toBe(0);
  });
});

describe("failure classification", () => {
  it("treats quota and provider outages as worth trying the next route", () => {
    expect(classify(429, "rate limited").retryable).toBe(true);
    expect(classify(500, "boom").retryable).toBe(true);
    expect(classify(503, "unavailable").retryable).toBe(true);
  });

  it("treats a bad key or bad request as final", () => {
    // Retrying a malformed prompt across three providers just burns three quotas.
    expect(classify(401, "invalid api key").retryable).toBe(false);
    expect(classify(400, "bad request").retryable).toBe(false);
    expect(classify(404, "no such model").retryable).toBe(false);
  });

  it("truncates provider error bodies so a key echoed back cannot fill the logs", () => {
    const error = classify(400, "x".repeat(5000));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message.length).toBeLessThanOrEqual(300);
  });
});

describe("adapter registry", () => {
  it.each(["GOOGLE", "ANTHROPIC", "OPENAI_COMPATIBLE"] as const)(
    "has an adapter for %s",
    (kind) => {
      const adapter = adapterFor(kind);
      expect(adapter.kind).toBe(kind);
      expect(typeof adapter.chat).toBe("function");
      expect(typeof adapter.ping).toBe("function");
    },
  );

  it("offers embeddings only where the provider has an embedding endpoint", () => {
    expect(adapterFor("GOOGLE").embed).toBeTypeOf("function");
    expect(adapterFor("OPENAI_COMPATIBLE").embed).toBeTypeOf("function");
    // Anthropic has no embedding API — the gateway falls through to a route that does.
    expect(adapterFor("ANTHROPIC").embed).toBeUndefined();
  });
});
