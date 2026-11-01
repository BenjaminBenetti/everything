import type { AgentModelInfo } from "@everything/agent-contracts";
import type { EffectiveModel } from "@everything/provider-contracts/inference";
import { providerOptions } from "../../provider/model/provider-options.js";

/** Readable provenance, without a frontend model catalog or capacity assumptions. */
const contextLabels = {
  provider: "Provider detected",
  catalog: "Catalog estimate",
  fallback: "Fallback (default)",
};
const imageLabels = {
  provider: "Provider detected",
  catalog: "Catalog estimate",
  documentation: "Documentation fallback",
  unknown: "Unknown",
};

/** Compare each applied fact, including provenance, rather than just the selected model name. */
function sameModel(left: EffectiveModel, right: EffectiveModel): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.contextWindow === right.contextWindow &&
    left.contextSource === right.contextSource &&
    left.imageInput === right.imageInput &&
    left.imageSource === right.imageSource
  );
}

/** Present the backend's exact budget and image policy for a single resolution. */
function ModelBudget({ model }: { model: EffectiveModel }) {
  return (
    <>
      <p className="muted model-info-identity">
        {providerOptions[model.provider].title} · {model.model}
      </p>
      <dl className="model-info-values">
        <div>
          <dt>Context window</dt>
          <dd>{model.contextWindow.toLocaleString("en-US")} tokens</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{contextLabels[model.contextSource]}</dd>
        </div>
        <div>
          <dt>Image input</dt>
          <dd>
            {model.imageInput === null
              ? "Unconfirmed"
              : model.imageInput
                ? "Supported"
                : "Unsupported"}{" "}
            · {imageLabels[model.imageSource]}
          </dd>
        </div>
      </dl>
      {model.contextSource === "fallback" && (
        <p className="muted">
          Assumed planning budget; the provider has not confirmed this context
          size.
        </p>
      )}
      {model.imageSource === "documentation" && (
        <p className="muted">
          Image support comes from{" "}
          <a
            className="text-link"
            href="https://developers.openai.com/api/docs/models/gpt-6.1-terra"
            target="_blank"
            rel="noreferrer"
          >
            OpenAI’s published specification
          </a>
          . It was not API-detected.
        </p>
      )}
    </>
  );
}

/** Keep loading, discovery failures and pinned runtime state distinct in both information panels. */
export function ModelInfoContent({
  info,
  pending = false,
  error = false,
}: {
  info?: AgentModelInfo | undefined;
  pending?: boolean;
  error?: boolean;
}) {
  if (pending) return <p role="status">Loading model details…</p>;
  if (error || !info)
    return (
      <p role="alert">
        Model details couldn’t load. Reopen your teammate’s details to try
        again.
      </p>
    );
  return (
    <section
      className="model-info"
      aria-label="Model context and image support"
    >
      <p className="eyebrow">Applied to loaded runtime</p>
      {info.applied ? (
        <ModelBudget model={info.applied} />
      ) : (
        <p className="muted">
          No runtime loaded. The selected budget will apply when your teammate
          starts work.
        </p>
      )}
      {info.selectionError ? (
        <p role="alert">
          Selected model details are unavailable. Any loaded runtime keeps its
          applied budget.
        </p>
      ) : info.selected &&
        (!info.applied || !sameModel(info.selected, info.applied)) ? (
        <>
          <p className="eyebrow">Selected model · next runtime</p>
          <ModelBudget model={info.selected} />
        </>
      ) : !info.selected ? (
        <p className="muted">No model selected.</p>
      ) : null}
      {info.applied && (
        <p className="muted">
          Applied details stay pinned until the runtime is recreated. Saving
          identical settings does not refresh them.
        </p>
      )}
    </section>
  );
}
