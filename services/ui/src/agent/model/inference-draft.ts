import type { ProviderId } from "@everything/provider-contracts";
import type {
  InferenceEffort,
  InferenceSelection,
  InferenceSpeed,
  ProviderModel,
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

/** A different model starts at its supported default effort with Fast mode off, so no paid speed carries over. */
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

/** Speeds a model offers; an API from before speeds existed lists none, which means standard only. */
function speeds(model: ProviderModel): readonly InferenceSpeed[] {
  return model.speeds ?? ["standard"];
}

/** Whether the model offers Fast mode. */
export function offersFast(model: ProviderModel | undefined): boolean {
  return !!model && speeds(model).includes("fast");
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
    speeds(model).includes(draft.speed)
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

/** The complete selection to save, or undefined while a choice is still missing. */
export function draftSelection(
  draft: InferenceDraft,
): InferenceSelection | undefined {
  const { provider, model, effort, speed } = draft;
  return provider && model && effort
    ? { provider, model, effort, speed }
    : undefined;
}
