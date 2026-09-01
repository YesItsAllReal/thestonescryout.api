export interface AuthenticatedPrincipal {
  readonly playerId: string;
  readonly sessionKind: "guest" | "account";
  readonly issuer: string;
  readonly audience: string;
}

export interface AccessTokenVerifier {
  verify(accessToken: string, now: Date): Promise<AuthenticatedPrincipal>;
}

export class AuthenticationRequiredError extends Error {}

export async function requirePrincipal(input: {
  readonly authorizationHeader: string | undefined;
  readonly verifier: AccessTokenVerifier;
  readonly now: Date;
}): Promise<AuthenticatedPrincipal> {
  const match = /^Bearer ([^\s]+)$/.exec(input.authorizationHeader ?? "");
  if (match?.[1] === undefined) throw new AuthenticationRequiredError("bearer token is required");
  try {
    return await input.verifier.verify(match[1], input.now);
  } catch {
    throw new AuthenticationRequiredError("bearer token is invalid");
  }
}
