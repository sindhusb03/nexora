export const dynamic = "force-dynamic";

/** Same-origin relay for the kernel health endpoint, which is outside the API's CORS scope. */
export async function GET(): Promise<Response> {
  const baseUrl = process.env.API_URL ?? "http://localhost:8787";
  try {
    const response = await fetch(`${baseUrl}/health`, { cache: "no-store" });
    if (!response.ok) {
      return Response.json(
        { error: { code: "KERNEL_UNHEALTHY", message: "The kernel health check failed" } },
        { status: 502 },
      );
    }
    const body: unknown = await response.json();
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      { error: { code: "NETWORK_UNREACHABLE", message: "Could not reach the kernel API" } },
      { status: 502 },
    );
  }
}
