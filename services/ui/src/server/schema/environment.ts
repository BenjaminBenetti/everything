import { Type, type Static } from "typebox";

/** The stateless host needs only a listen port. */
export const environmentSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
});
export type ServerEnvironment = Static<typeof environmentSchema>;
