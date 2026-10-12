/** Back-channel token requests, sent as if through the public origin so tokens carry its issuer. */
export function keycloakTokenRequest(
  publicOrigin: string,
  parameters: Record<string, string>,
): RequestInit {
  const origin = new URL(publicOrigin);
  return {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-Forwarded-Proto": origin.protocol.slice(0, -1),
      "X-Forwarded-Host": origin.host,
      "X-Forwarded-Port":
        origin.port || (origin.protocol === "https:" ? "443" : "80"),
    },
    body: new URLSearchParams(parameters),
  };
}
