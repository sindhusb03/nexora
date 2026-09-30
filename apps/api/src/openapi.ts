import { z } from "zod";

import { openApiSchemas } from "./schemas.js";

/** OpenAPI document emitted from the Zod route schemas. */
export function buildOpenApi(): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(openApiSchemas)) {
    components[name] = z.toJSONSchema(schema);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Financial Ecosystem",
      version: "0.1.0",
      description:
        "Server-side Financial Kernel. Clients display these results and do not calculate them.",
    },
    paths: {
      "/health": { get: { summary: "Kernel health" } },
      "/ready": { get: { summary: "Store readiness" } },
      "/auth/login": {
        post: { summary: "Sign in; sets the signed session cookie and returns the CSRF token" },
      },
      "/auth/logout": { post: { summary: "Revoke the current session" } },
      "/auth/session": { get: { summary: "The signed-in actor, tenant, region, and roles" } },
      "/auth/session/tenant": { post: { summary: "Select a tenant the actor belongs to" } },
      "/v1/financial-states": {
        post: { summary: "Draft a financial state", requestBody: ref("financialState") },
      },
      "/v1/financial-states/{id}": { get: { summary: "Read one financial state version" } },
      "/v1/valuations/{id}": {
        get: { summary: "Read one valuation version and its stored kernel result" },
      },
      "/v1/financial-states/{id}/transition": {
        post: { summary: "Append a publication transition", requestBody: ref("transition") },
      },
      "/v1/lineage/{type}/{id}": { get: { summary: "Lineage edges" } },
      "/v1/valuations": {
        post: { summary: "Create a valuation from the DCF kernel", requestBody: ref("valuation") },
      },
      "/v1/valuations/{id}/transition": {
        post: { summary: "Publish a succeeded valuation", requestBody: ref("transition") },
      },
      "/v1/report-packs": {
        post: {
          summary: "Freeze a board pack from published states",
          requestBody: ref("reportPack"),
        },
      },
      "/v1/capital/debt": { post: { summary: "Roll a debt schedule", requestBody: ref("debt") } },
      "/v1/capital/cap-table": {
        post: { summary: "Reconcile a cap table", requestBody: ref("capTable") },
      },
      "/v1/imports": {
        post: { summary: "Import a source file once", requestBody: ref("importBatch") },
      },
      "/v1/proposals": {
        post: { summary: "Suggest a cited change", requestBody: ref("proposal") },
      },
      "/v1/deals": {
        post: { summary: "Apply a deal scenario to a published hash", requestBody: ref("deal") },
      },
      "/v1/reporting-bases": {
        post: { summary: "Map a local chart onto a group basis", requestBody: ref("basis") },
      },
    },
    components: { schemas: components },
  };
}

function ref(name: string) {
  return { content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } };
}
