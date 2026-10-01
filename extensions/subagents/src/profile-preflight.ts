import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./backends/pi.ts";
import type { BackendName } from "./domain.ts";
import type { AgentProfile } from "./profiles.ts";
import type { RoutingState, TaskKind } from "./routing.ts";

/** A model hint must be validated for the chosen harness before quota ranking. */
export function profileCandidateModelEligible(
  harness: BackendName,
  model: string | undefined,
  registry: ModelRegistry,
  inherited?: { provider: string; id: string },
): boolean {
  if (harness === "pi") {
    // The SDK default is not necessarily the authenticated model we checked.
    if (!model && !inherited) return false;
    try {
      resolvePiModel(registry, model, inherited);
      return true;
    } catch {
      return false;
    }
  }
  // The CLI being installed does not authenticate a particular named model.
  return model === undefined && (harness === "claude" || harness === "codex");
}

/** Preflight effective models before quota ranking; never weaken hard requirements. */
export function verifiedProfileHarnesses(options: {
  profile: AgentProfile;
  taskKind: TaskKind;
  state: RoutingState;
  modelRegistry: ModelRegistry;
  inherited?: { provider: string; id: string };
  explicitModel?: string;
  override?: BackendName;
  claudeAuthenticated?: boolean;
}): ReadonlySet<BackendName> {
  const {
    profile,
    taskKind,
    state,
    modelRegistry,
    inherited,
    explicitModel,
    override,
    claudeAuthenticated,
  } = options;
  if (profile.requires.length > 0) return new Set();
  const eligible = new Set<BackendName>();
  for (const harness of ["pi", "claude", "codex"] as const) {
    // Installed Codex multi_agent is enabled. Until an enforcing per-child
    // disable is proven, refuse profiled Codex instead of relying on a prompt.
    if (harness === "codex") continue;
    if (harness === "claude" && claudeAuthenticated !== true) continue;
    if (Object.keys(profile.harness).length && !profile.harness[harness])
      continue;
    const configured =
      state.models?.[taskKind]?.filter((entry) => entry.harness === harness) ??
      [];
    const models =
      override === harness && explicitModel
        ? [explicitModel]
        : configured.length
          ? configured.map(
              (entry) => profile.harness[harness]?.model ?? entry.model,
            )
          : [profile.harness[harness]?.model];
    if (
      models.some((model) =>
        profileCandidateModelEligible(harness, model, modelRegistry, inherited),
      )
    ) {
      eligible.add(harness);
    }
  }
  return eligible;
}
