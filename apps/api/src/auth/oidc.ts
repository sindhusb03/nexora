import { createHash, randomBytes } from "node:crypto";

/** Shape of one OIDC provider. A deployment may configure zero providers. */
export interface OidcProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

export interface OidcStart {
  readonly state: string;
  readonly nonce: string;
  readonly stateHash: string;
  readonly nonceHash: string;
  readonly authorizeUrl: string;
}

export function startOidc(provider: OidcProviderConfig): OidcStart {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const issuer = provider.issuer.replace(/\/$/, "");
  const url = new URL(`${issuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", provider.redirectUri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return {
    state,
    nonce,
    stateHash: sha256(state),
    nonceHash: sha256(nonce),
    authorizeUrl: url.toString(),
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
