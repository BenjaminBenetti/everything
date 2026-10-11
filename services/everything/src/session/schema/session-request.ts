import { Type, type Static } from "typebox";
import { sessionInputLimits } from "../model/stored-session.js";

/** Credentials are accepted only in a bounded JSON request body. */
export const signInBody = Type.Object(
  {
    username: Type.String({
      minLength: 1,
      maxLength: sessionInputLimits.username,
      pattern: "\\S",
    }),
    password: Type.String({
      minLength: 1,
      maxLength: sessionInputLimits.password,
    }),
  },
  { additionalProperties: false },
);
export type SignInBody = Static<typeof signInBody>;
