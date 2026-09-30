import { isPlatform, isSession, isWorkspace, type CompanyCard, type CopilotReply, type PlatformView, type SessionView, type Workspace } from "./types";

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
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
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

export async function login(actorId: string, password: string): Promise<SessionView> {
  const body = await request("/auth/login", { method: "POST", body: JSON.stringify({ actorId, password, region: "us-east-1" }) }, null);
  if (!isSession(body)) throw new ApiFailure(500, "The session response was not readable");
  return body;
}

export async function logout(csrf: string): Promise<void> {
  await request("/auth/logout", { method: "POST" }, csrf);
}

export async function listCompanies(csrf: string): Promise<readonly CompanyCard[]> {
  const body = await request("/v1/workspace/companies", { method: "GET" }, csrf);
  if (typeof body !== "object" || body === null || !Array.isArray((body as { companies?: unknown }).companies)) return [];
  return (body as { companies: CompanyCard[] }).companies;
}

export async function selectTenant(csrf: string, tenantId: string): Promise<SessionView> {
  const body = await request("/auth/session/tenant", { method: "POST", body: JSON.stringify({ tenantId }) }, csrf);
  if (!isSession(body)) throw new ApiFailure(500, "The tenant switch was not readable");
  return body;
}

export async function fetchWorkspace(csrf: string): Promise<Workspace> {
  const body = await request("/v1/workspace", { method: "GET" }, csrf);
  if (!isWorkspace(body)) throw new ApiFailure(500, "The workspace snapshot was not readable");
  return body;
}

export async function saveForecast(csrf: string, drivers: Workspace["forecast"]["drivers"] & { scenarioGrowthRate: string }): Promise<Workspace> {
  const body = await request("/v1/workspace/forecast", { method: "POST", body: JSON.stringify(drivers) }, csrf);
  if (!isWorkspace(body)) throw new ApiFailure(500, "The forecast was not readable");
  return body;
}

export async function decideProposal(csrf: string, id: string, decision: "accepted" | "rejected"): Promise<Workspace> {
  const body = await request(`/v1/workspace/proposals/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) }, csrf);
  if (!isWorkspace(body)) throw new ApiFailure(500, "The decision was not readable");
  return body;
}

export async function askCopilot(csrf: string, message: string, agent: string): Promise<CopilotReply> {
  const body = await request("/v1/copilot", { method: "POST", body: JSON.stringify({ message, agent }) }, csrf);
  if (typeof body !== "object" || body === null || typeof (body as { text?: unknown }).text !== "string") {
    throw new ApiFailure(500, "The copilot reply was not readable");
  }
  return body as CopilotReply;
}

export async function inviteMember(csrf: string, actorId: string, role: string): Promise<Workspace> {
  const body = await request("/v1/admin/members", { method: "POST", body: JSON.stringify({ actorId, role }) }, csrf);
  if (!isWorkspace(body)) throw new ApiFailure(500, "The membership update was not readable");
  return body;
}

export async function fetchPlatform(csrf: string): Promise<PlatformView> {
  const body = await request("/v1/admin/platform", { method: "GET" }, csrf);
  if (!isPlatform(body)) throw new ApiFailure(500, "The platform console was not readable");
  return body;
}

export async function setTenantStatus(csrf: string, tenantId: string, status: "active" | "suspended"): Promise<PlatformView> {
  const body = await request(`/v1/admin/tenants/${tenantId}/status`, { method: "POST", body: JSON.stringify({ status }) }, csrf);
  if (!isPlatform(body)) throw new ApiFailure(500, "The tenant update was not readable");
  return body;
}

export async function setFlag(csrf: string, id: string, enabled: boolean): Promise<PlatformView> {
  const body = await request(`/v1/admin/flags/${id}`, { method: "POST", body: JSON.stringify({ enabled }) }, csrf);
  if (!isPlatform(body)) throw new ApiFailure(500, "The flag update was not readable");
  return body;
}

export async function grantSupport(csrf: string, tenantId: string, hours: number, reason: string): Promise<PlatformView> {
  const body = await request("/v1/admin/support", { method: "POST", body: JSON.stringify({ tenantId, hours, reason }) }, csrf);
  if (!isPlatform(body)) throw new ApiFailure(500, "The support grant was not readable");
  return body;
}
