import { Suspense } from "react";

import { HomeView, type KernelHealth } from "../home-view";

export const dynamic = "force-dynamic";

export default async function ClassicPage() {
  const health = await loadKernelHealth();
  return (
    <Suspense fallback={null}>
      <HomeView health={health} />
    </Suspense>
  );
}

async function loadKernelHealth(): Promise<KernelHealth | null> {
  const baseUrl = process.env.API_URL ?? "http://127.0.0.1:8787";
  try {
    const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isHealth(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function isHealth(value: unknown): value is KernelHealth {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.status === "string" && typeof record.service === "string" && typeof record.engineVersion === "string";
}
