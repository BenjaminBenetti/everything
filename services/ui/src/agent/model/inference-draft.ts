import type { ProviderId } from "@everything/provider-contracts";
import {
  inferenceSpeeds,
  type InferenceEffort,
  type InferenceSelection,
  type InferenceSpeed,
  type ProviderModel,
} from "@everything/provider-contracts/inference";

/** Keep dependent choices in the teammate draft so avatar selection and retries preserve them. */
export interface InferenceDraft {
  readonly provider: ProviderId | "";
  readonly model: string;
  readonly effort: InferenceEffort | "";
  readonly speed: InferenceSpeed;
}

/** A saved selection as an editable draft; selections saved before speeds existed request standard. */
export function inferenceDraft(
  saved: InferenceSelection | null | undefined,
): InferenceDraft {
  return saved
    ? {
        provider: saved.provider,
        model: saved.model,
        effort: saved.effort,
        speed: saved.speed ?? "standard",
      }
    : { provider: "", model: "", effort: "", speed: "standard" };
}

/** Changing providers clears every dependent setting instead of silently retaining an invalid choice. */
export function withProvider(provider: ProviderId | ""): InferenceDraft {
  return { provider, model: "", effort: "", speed: "standard" };
}

/** A different model starts at its supported default effort at standard speed, so no paid speed carries over. */
export function withModel(
  draft: InferenceDraft,
  id: string,
  model: ProviderModel | undefined,
): InferenceDraft {
  return {
    ...draft,
    model: id,
    effort: model?.defaultEffort ?? "",
    speed: "standard",
  };
}

/**
 * Speeds a model offers, none without a model; an API from before speeds existed lists none, which
 * means standard only.
 */
export function offeredSpeeds(
  model: ProviderModel | undefined,
): readonly InferenceSpeed[] {
  return model ? (model.speeds ?? ["standard"]) : [];
}

/** Whether the model offers Fast mode. */
export function offersFast(model: ProviderModel | undefined): boolean {
  return offeredSpeeds(model).includes("fast");
}

/** A speed beyond standard, which uses more of the plan or credits. */
type PaidSpeed = Exclude<InferenceSpeed, "standard">;

/** How the editor offers a model's speeds: not at all, Fast mode's switch, or a menu with Ultrafast. */
export interface SpeedControl {
  readonly kind: "none" | "switch" | "menu";
  /** The menu's speeds in order, each marked with whether the model offers it. */
  readonly choices: readonly {
    readonly speed: InferenceSpeed;
    readonly offered: boolean;
  }[];
  /** A saved paid speed the model doesn't offer, shown so it can be changed before saving. */
  readonly unsupported?: PaidSpeed;
}

/**
 * The speed control for a draft's speed on a model. Ultrafast needs a menu; a model that offers
 * only Fast keeps its switch. A saved paid speed the model doesn't offer stays visible, unavailable,
 * rather than being replaced by another speed.
 */
export function speedControl(
  speed: InferenceSpeed,
  model: ProviderModel | undefined,
): SpeedControl {
  const offered = offeredSpeeds(model);
  const paid = speed !== "standard" ? speed : undefined;
  const unsupported =
    model && paid && !offered.includes(paid) ? paid : undefined;
  const flags = unsupported ? { unsupported } : {};
  if (model && (offered.includes("ultrafast") || paid === "ultrafast"))
    return {
      kind: "menu",
      choices: inferenceSpeeds
        .filter((choice) => offered.includes(choice) || choice === paid)
        .map((choice) => ({
          speed: choice,
          offered: offered.includes(choice),
        })),
      ...flags,
    };
  return {
    kind: offered.includes("fast") || unsupported ? "switch" : "none",
    choices: [],
    ...flags,
  };
}

/** Whether the draft uses only an effort and speed the model supports. */
export function isSupportedDraft(
  draft: InferenceDraft,
  model: ProviderModel | undefined,
): boolean {
  return (
    !!model &&
    !!draft.effort &&
    model.efforts.includes(draft.effort) &&
    offeredSpeeds(model).includes(draft.speed)
  );
}

/** Whether the draft differs from the saved selection. */
export function isChangedDraft(
  draft: InferenceDraft,
  saved: InferenceSelection | null | undefined,
): boolean {
  const current = inferenceDraft(saved);
  return (
    draft.provider !== current.provider ||
    draft.model !== current.model ||
    draft.effort !== current.effort ||
    draft.speed !== current.speed
  );
}

/**
 * The complete selection to save, or undefined while a choice is still missing. Standard is sent
 * as no speed, which the API reads the same way and which an API from before speeds existed accepts.
 */
export function draftSelection(
  draft: InferenceDraft,
): InferenceSelection | undefined {
  const { provider, model, effort, speed } = draft;
  return provider && model && effort
    ? { provider, model, effort, ...(speed !== "standard" ? { speed } : {}) }
    : undefined;
}
