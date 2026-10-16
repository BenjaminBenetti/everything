import { ApplicationError } from "@everything/errors";

/** Invalid search input must not become an unrestricted history read. */
export class ConversationSearchInputError extends ApplicationError {
  /** Tell the caller to follow the tool's bounded search schema. */
  constructor() {
    super(
      400,
      "CONVERSATION_SEARCH_INPUT_INVALID",
      "Provide a non-empty search phrase and valid conversation search filters.",
    );
  }
}
