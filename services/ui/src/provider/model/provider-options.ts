import type { ProviderId } from "@everything/provider-contracts";

/** Shared presentation for the provider picker and its individual setup pages. */
export const providerOptions = {
  chatgpt: {
    title: "ChatGPT",
    description: "Use your ChatGPT plan with Everything.",
  },
  anthropic: {
    title: "Claude",
    description: "Connect with an Anthropic API key.",
  },
  "openai-compatible": {
    title: "OpenAI-compatible API",
    description: "Hosted APIs and your own local models.",
  },
} satisfies Record<ProviderId, { title: string; description: string }>;
