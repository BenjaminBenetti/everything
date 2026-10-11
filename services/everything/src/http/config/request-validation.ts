/** Reject input that does not match a route schema instead of silently stripping or coercing it. */
export const strictRequestValidation = {
  customOptions: { removeAdditional: false, coerceTypes: false },
} as const;
