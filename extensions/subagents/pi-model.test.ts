import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./src/backends/pi.ts";

function model(provider: string, id: string): Model<any> {
  return { provider, id } as Model<any>;
}

function registry(options: {
  all: ReadonlyArray<Model<any>>;
  available: ReadonlyArray<Model<any>>;
}): ModelRegistry {
  return {
    getAll: () => [...options.all],
    getAvailable: () => [...options.available],
    find: (provider: string, id: string) =>
      options.all.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      ),
  } as unknown as ModelRegistry;
}

test("bare Pi model hints ignore unauthenticated providers", () => {
  const cloudflare = model("cloudflare-ai-gateway", "claude-sonnet-4.5");
  const copilot = model("github-copilot", "claude-sonnet-4.5");
  const models = registry({
    all: [cloudflare, copilot],
    available: [copilot],
  });

  const selected = resolvePiModel(models, "claude-sonnet-4.5", {
    provider: "cloudflare-ai-gateway",
    id: "gpt-5.6-sol",
  });

  assert.equal(selected, copilot);
});

test("an unavailable inherited Pi model fails instead of silently falling back", () => {
  const cloudflare = model("cloudflare-ai-gateway", "claude-sonnet-4.5");
  const models = registry({ all: [cloudflare], available: [] });

  assert.throws(
    () =>
      resolvePiModel(models, undefined, {
        provider: "cloudflare-ai-gateway",
        id: "claude-sonnet-4.5",
      }),
    /Inherited model.*not authenticated or available/,
  );
});

test("provider-qualified Pi model hints fail before spawn when unavailable", () => {
  const cloudflare = model("cloudflare-ai-gateway", "claude-sonnet-4.5");
  const models = registry({ all: [cloudflare], available: [] });

  assert.throws(
    () =>
      resolvePiModel(
        models,
        "cloudflare-ai-gateway/claude-sonnet-4.5",
        undefined,
      ),
    /not authenticated or available/,
  );
});

test("bare Pi model hints remain ambiguous across authenticated providers", () => {
  const copilot = model("github-copilot", "shared-model");
  const codex = model("openai-codex", "shared-model");
  const models = registry({
    all: [copilot, codex],
    available: [copilot, codex],
  });

  assert.throws(
    () => resolvePiModel(models, "shared-model", undefined),
    /multiple authenticated providers.*github-copilot, openai-codex/,
  );
});
