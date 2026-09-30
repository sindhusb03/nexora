import {
  isPlatform,
  isSession,
  isWorkspace,
  type CompanyCard,
  type CopilotReply,
  type PlatformView,
  type SessionView,
  type Workspace,
} from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";

export class ApiFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, init: RequestInit, csrf: string | null): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (csrf) headers.set("x-csrf-token", csrf);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = readError(body) ?? `Request failed (${response.status})`;
    throw new ApiFailure(response.status, message);
  }
  return body;
}

function readError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : null;
}

export async function fetchSession(): Promise<SessionView | null> {
  try {
    const body = await request("/auth/session", { method: "GET" }, null);
    return isSession(body) ? body : null;
  } catch (error) {
    if (error instanceof ApiFailure && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

export interface AuthConfigView {
  readonly demoMode: boolean;
  readonly signupAllowed: boolean;
  readonly region: string | null;
  readonly oidcProviders: readonly { readonly id: string; readonly label: string }[];
}

export type LoginResult =
  | { readonly kind: "session"; readonly session: SessionView }
  | { readonly kind: "mfa"; readonly challengeId: string };

export async function fetchAuthConfig(): Promise<AuthConfigView> {
  const body = await request("/auth/config", { method: "GET" }, null);
  if (typeof body !== "object" || body === null) {
    return { demoMode: false, signupAllowed: false, region: null, oidcProviders: [] };
  }
  const record = body as {
    demoMode?: unknown;
    signupAllowed?: unknown;
    region?: unknown;
    oidcProviders?: unknown;
  };
  const providers = Array.isArray(record.oidcProviders)
    ? record.oidcProviders.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const provider = item as { id?: unknown; label?: unknown };
        return typeof provider.id === "string" && typeof provider.label === "string"
          ? [{ id: provider.id, label: provider.label }]
          : [];
      })
    : [];
  return {
    demoMode: record.demoMode === true,
    signupAllowed: record.signupAllowed === true,
    region: typeof record.region === "string" ? record.region : null,
    oidcProviders: providers,
  };
}

function readLogin(body: unknown): LoginResult {
  if (
    typeof body === "object" &&
    body !== null &&
    (body as { mfaRequired?: unknown }).mfaRequired === true
  ) {
    const challengeId = (body as { challengeId?: unknown }).challengeId;
    if (typeof challengeId !== "string") {
      throw new ApiFailure(500, "The second-factor challenge was not readable");
    }
    return { kind: "mfa", challengeId };
  }
  if (!isSession(body)) throw new ApiFailure(500, "The session response was not readable");
  return { kind: "session", session: body };
}

export async function login(
  actorId: string,
  password: string,
  region: string | null,
): Promise<LoginResult> {
  const body = await request(
    "/auth/login",
    { method: "POST", body: JSON.stringify(withRegion({ actorId, password }, region)) },
    null,
  );
  return readLogin(body);
}

export async function requestMagicLink(email: string): Promise<string> {
  const body = await request(
    "/auth/magic-link",
    { method: "POST", body: JSON.stringify({ email }) },
    null,
  );
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { message?: unknown }).message === "string"
  ) {
    return (body as { message: string }).message;
  }
  return "If an account exists for that address, a sign-in link was sent.";
}

export async function consumeMagicLink(token: string, region: string | null): Promise<LoginResult> {
  const body = await request(
    "/auth/magic-link/consume",
    { method: "POST", body: JSON.stringify(withRegion({ token }, region)) },
    null,
  );
  return readLogin(body);
}

function withRegion(fields: Record<string, string>, region: string | null): Record<string, string> {
  return region ? { ...fields, region } : fields;
}

export async function verifySecondFactor(
  challengeId: string,
  code: string,
  recovery: boolean,
): Promise<SessionView> {
  const body = await request(
    "/auth/2fa/verify",
    {
      method: "POST",
      body: JSON.stringify(recovery ? { challengeId, recoveryCode: code } : { challengeId, code }),
    },
    null,
  );
  const result = readLogin(body);
  if (result.kind !== "session") throw new ApiFailure(500, "The session response was not readable");
  return result.session;
}

export async function enrollTotp(
  csrf: string,
  password: string,
): Promise<{ readonly secret: string; readonly qrDataUrl: string; readonly otpauthUrl: string }> {
  const body = await request(
    "/auth/2fa/enroll",
    { method: "POST", body: JSON.stringify({ password }) },
    csrf,
  );
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { secret?: unknown }).secret !== "string" ||
    typeof (body as { qrDataUrl?: unknown }).qrDataUrl !== "string"
  ) {
    throw new ApiFailure(500, "Two-factor enrollment was not readable");
  }
  const record = body as { secret: string; qrDataUrl: string; otpauthUrl?: unknown };
  return {
    secret: record.secret,
    qrDataUrl: record.qrDataUrl,
    otpauthUrl: typeof record.otpauthUrl === "string" ? record.otpauthUrl : "",
  };
}

export async function disableTotp(csrf: string, password: string, code: string): Promise<void> {
  await request(
    "/auth/2fa/disable",
    { method: "POST", body: JSON.stringify({ password, code }) },
    csrf,
  );
}

export async function confirmTotp(csrf: string, code: string): Promise<readonly string[]> {
  const body = await request(
    "/auth/2fa/confirm",
    { method: "POST", body: JSON.stringify({ code }) },
    csrf,
  );
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { recoveryCodes?: unknown }).recoveryCodes)
  ) {
    throw new ApiFailure(500, "Recovery codes were not readable");
  }
  return (body as { recoveryCodes: unknown[] }).recoveryCodes.filter(
    (code): code is string => typeof code === "string",
  );
}

export async function logout(csrf: string): Promise<void> {
  await request("/auth/logout", { method: "POST" }, csrf);
}

export async function listCompanies(csrf: string): Promise<readonly CompanyCard[]> {
  const body = await request("/v1/workspace/companies", { method: "GET" }, csrf);
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { companies?: unknown }).companies)
  )
    return [];
  return (body as { companies: CompanyCard[] }).companies;
}

export async function selectTenant(csrf: string, tenantId: string): Promise<SessionView> {
  const body = await request(
    "/auth/session/tenant",
    { method: "POST", body: JSON.stringify({ tenantId }) },
    csrf,
  );
  if (!isSession(body)) throw new ApiFailure(500, "The tenant switch was not readable");
  return body;
}

export async function fetchWorkspace(csrf: string): Promise<Workspace> {
  const body = await request("/v1/workspace", { method: "GET" }, csrf);
  if (!isWorkspace(body)) throw new ApiFailure(500, "The workspace snapshot was not readable");
  return body;
}

export async function saveForecast(
  csrf: string,
  drivers: Workspace["forecast"]["drivers"] & { scenarioGrowthRate: string },
): Promise<Workspace> {
  const body = await request(
    "/v1/workspace/forecast",
    { method: "POST", body: JSON.stringify(drivers) },
    csrf,
  );
  if (!isWorkspace(body)) throw new ApiFailure(500, "The forecast was not readable");
  return body;
}

export async function decideProposal(
  csrf: string,
  id: string,
  decision: "accepted" | "rejected",
): Promise<Workspace> {
  const body = await request(
    `/v1/workspace/proposals/${id}/decide`,
    { method: "POST", body: JSON.stringify({ decision }) },
    csrf,
  );
  if (!isWorkspace(body)) throw new ApiFailure(500, "The decision was not readable");
  return body;
}

export async function askCopilot(
  csrf: string,
  message: string,
  agent: string,
): Promise<CopilotReply> {
  const body = await request(
    "/v1/copilot",
    { method: "POST", body: JSON.stringify({ message, agent }) },
    csrf,
  );
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { text?: unknown }).text !== "string"
  ) {
    throw new ApiFailure(500, "The copilot reply was not readable");
  }
  return body as CopilotReply;
}

export async function inviteMember(
  csrf: string,
  actorId: string,
  role: string,
): Promise<Workspace> {
  const body = await request(
    "/v1/admin/members",
    { method: "POST", body: JSON.stringify({ actorId, role }) },
    csrf,
  );
  if (!isWorkspace(body)) throw new ApiFailure(500, "The membership update was not readable");
  return body;
}

export async function fetchPlatform(csrf: string): Promise<PlatformView> {
  const body = await request("/v1/admin/platform", { method: "GET" }, csrf);
  if (!isPlatform(body)) throw new ApiFailure(500, "The platform console was not readable");
  return body;
}

export async function setTenantStatus(
  csrf: string,
  tenantId: string,
  status: "active" | "suspended",
): Promise<PlatformView> {
  const body = await request(
    `/v1/admin/tenants/${tenantId}/status`,
    { method: "POST", body: JSON.stringify({ status }) },
    csrf,
  );
  if (!isPlatform(body)) throw new ApiFailure(500, "The tenant update was not readable");
  return body;
}

export async function setFlag(csrf: string, id: string, enabled: boolean): Promise<PlatformView> {
  const body = await request(
    `/v1/admin/flags/${id}`,
    { method: "POST", body: JSON.stringify({ enabled }) },
    csrf,
  );
  if (!isPlatform(body)) throw new ApiFailure(500, "The flag update was not readable");
  return body;
}

export async function grantSupport(
  csrf: string,
  tenantId: string,
  hours: number,
  reason: string,
): Promise<PlatformView> {
  const body = await request(
    "/v1/admin/support",
    { method: "POST", body: JSON.stringify({ tenantId, hours, reason }) },
    csrf,
  );
  if (!isPlatform(body)) throw new ApiFailure(500, "The support grant was not readable");
  return body;
}
