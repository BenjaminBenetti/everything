import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrowserSession } from "@everything/security/browser";
import type {
  EffectiveModel,
  InferenceSelection,
} from "@everything/provider-contracts/inference";
import { ContextRow } from "../component/context-row.js";
import { contextTokens, matchingContext } from "../model/context-budget.js";
import { ConversationTeammateCard } from "../../conversation/component/conversation-teammate-card.js";
import { SessionProvider } from "../../session/component/session-provider.js";
import { AgentDirectoryProvider } from "../component/agent-directory-provider.js";
import { HttpAgentDirectory } from "../adapter/http-agent-directory.js";
import { HttpProviderConnections } from "../../provider/adapter/http-provider-connections.js";
import { ProviderConnectionsProvider } from "../../provider/component/provider-connections-context.js";

const selection: InferenceSelection = {
  provider: "chatgpt",
  model: "gpt-6.1-terra",
  effort: "off",
};
const applied: EffectiveModel = {
  ...selection,
  contextWindow: 200000,
  contextSource: "fallback",
  imageInput: true,
  imageSource: "documentation",
};

test("the production context row has only a formatted count or the same quiet placeholder", () => {
  assert.equal(
    renderToStaticMarkup(createElement(ContextRow, { tokens: 200000 })),
    "<div><dt>Context</dt><dd>200,000 tokens</dd></div>",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ContextRow, { tokens: 8192, flat: true }),
    ),
    "<dt>Context</dt><dd>8,192 tokens</dd>",
  );
  assert.equal(
    renderToStaticMarkup(createElement(ContextRow, {})),
    "<div><dt>Context</dt><dd>—</dd></div>",
  );
});

test("prefer the matching applied budget, otherwise use the matching selected budget", () => {
  const selected = { ...applied, contextWindow: 16384 };
  assert.equal(
    matchingContext({ applied, selected, selectionError: false }, selection),
    200000,
  );
  const next = { ...selection, model: "another-model" };
  assert.equal(
    matchingContext({ applied, selected, selectionError: false }, next),
    undefined,
  );
  assert.equal(
    matchingContext(
      {
        applied,
        selected: { ...selected, model: next.model },
        selectionError: false,
      },
      next,
    ),
    16384,
  );
  assert.equal(
    matchingContext(
      { applied, selected: null, selectionError: true },
      selection,
    ),
    200000,
  );
  assert.equal(
    matchingContext(
      {
        applied: { ...applied, provider: "anthropic" },
        selected: null,
        selectionError: true,
      },
      selection,
    ),
    undefined,
  );
});

test("untrusted counts cannot fabricate a capacity", () => {
  for (const value of [0, -1, NaN, Infinity, 2.5, "200000", null, 100000001])
    assert.equal(contextTokens(value), false);
  assert.equal(
    matchingContext(
      {
        applied: { ...applied, contextWindow: -1 },
        selected: null,
        selectionError: false,
      },
      selection,
    ),
    undefined,
  );
});

test("the real teammate card puts exactly one quiet Context row immediately after Effort", () => {
  const queries = new QueryClient();
  const session: BrowserSession = {
    initialize: async () => null,
    signIn: async () => {
      throw new Error("Unused");
    },
    signOut: async () => {},
  };
  const transport = {
    request: async <T>(): Promise<T> => {
      throw new Error("SSR must not request metadata");
    },
  };
  const card = createElement(ConversationTeammateCard, {
    agent: {
      id: "avery",
      name: "Avery",
      avatarId: "avatar-03",
      systemPrompt: "Synthetic fixture",
      createdAt: "2026-11-02T00:00:00Z",
      inference: selection,
    },
    activity: { kind: "idle" },
    backgroundCount: 0,
    onEdit: () => {},
  });
  const providers = createElement(ProviderConnectionsProvider, {
    connections: new HttpProviderConnections(transport),
    children: card,
  });
  const directory = createElement(AgentDirectoryProvider, {
    directory: new HttpAgentDirectory(transport),
    children: providers,
  });
  const auth = createElement(SessionProvider, { session, children: directory });
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queries, children: auth }),
  );
  const grid = html.match(/<dl class="chat-teammate-model">(.*?)<\/dl>/s)![1]!;
  assert.equal((grid.match(/<dt>Context<\/dt>/g) ?? []).length, 1);
  assert.match(
    grid,
    /<dt>Effort<\/dt><dd>.*?<\/dd><\/div><div><dt>Context<\/dt><dd>—<\/dd><\/div>$/,
  );
  for (const removed of [
    "Applied",
    "Selected",
    "Source",
    "Image input",
    "Documentation",
    "pinning",
    "Loading model",
    "model-info",
    "title=",
  ])
    assert.ok(!grid.includes(removed), removed);
  queries.clear();
});
