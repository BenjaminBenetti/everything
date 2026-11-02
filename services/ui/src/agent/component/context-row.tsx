/** One ordinary metadata row; loading and unavailable values stay in the same quiet cell. */
export function ContextRow({
  tokens,
  flat = false,
}: {
  tokens?: number | undefined;
  flat?: boolean;
}) {
  const cells = (
    <>
      <dt>Context</dt>
      <dd>
        {tokens === undefined
          ? "—"
          : `${tokens.toLocaleString("en-US")} tokens`}
      </dd>
    </>
  );
  return flat ? cells : <div>{cells}</div>;
}
