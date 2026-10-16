import { Type } from "typebox";

/** Successful operations returning HTTP 204 have no response body. */
export const noContentResponse = Type.Null({
  description: "Completed with no response body.",
});

/** Expected failures use the shared application's safe public error envelope. */
export const errorResponse = Type.Object(
  { code: Type.String(), message: Type.String() },
  {
    description:
      "The request could not be completed; code identifies the failure and message is safe to display.",
  },
);
