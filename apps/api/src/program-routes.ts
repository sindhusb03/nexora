import type { CalcNode } from "@nexora/kernel";
import type { Hono } from "hono";
import { z } from "zod";

import { buildOpenApi } from "./openapi.js";
import type { createProgramService } from "./program-service.js";
import {
  acceptProposalSchema,
  basisSchema,
  capTableSchema,
  dealSchema,
  debtSchema,
  eliminationSchema,
  financialStateSchema,
  fxSetSchema,
  groupSchema,
  importSchema,
  lboSchema,
  modelSchema,
  modelVersionSchema,
  ownershipSchema,
  proposalSchema,
  qoeSchema,
  reportPackSchema,
  sensitivitySchema,
  scenarioSchema,
  sourcesUsesSchema,
  transitionSchema,
  translateSchema,
} from "./schemas.js";
import { dcfSchema } from "./schemas.js";
import { readActor, type AppEnv } from "./http.js";

type ProgramService = ReturnType<typeof createProgramService>;

export function registerProgramRoutes(app: Hono<AppEnv>, program: ProgramService): void {
  app.get("/openapi.json", (c) => c.json(buildOpenApi()));

  app.post("/v1/financial-states", async (c) => {
    const body = financialStateSchema.parse(await c.req.json());
    return c.json(await program.createFinancialState(readActor(c), body), 201);
  });
  app.get("/v1/financial-states/:id", async (c) => {
    return c.json(await program.readFinancialStateVersion(readActor(c), z.uuid().parse(c.req.param("id"))));
  });
  app.get("/v1/valuations/:id", async (c) => {
    return c.json(await program.readValuationVersion(readActor(c), z.uuid().parse(c.req.param("id"))));
  });
  app.post("/v1/financial-states/:id/transition", async (c) => {
    const body = transitionSchema.parse(await c.req.json());
    return c.json(await program.transitionFinancialState(readActor(c), z.uuid().parse(c.req.param("id")), body.to));
  });
  app.get("/v1/lineage/:type/:id", async (c) => {
    return c.json(await program.lineage(readActor(c), c.req.param("type"), c.req.param("id")));
  });
  app.post("/v1/fx-rate-sets", async (c) => {
    const body = fxSetSchema.parse(await c.req.json());
    return c.json(await program.createFxRateSet(readActor(c), body), 201);
  });
  app.post("/v1/consolidation-groups", async (c) => {
    const body = groupSchema.parse(await c.req.json());
    return c.json(await program.createGroup(readActor(c), body), 201);
  });
  app.post("/v1/consolidation-groups/:id/translate", async (c) => {
    const body = translateSchema.parse(await c.req.json());
    return c.json(await program.translateGroup(readActor(c), z.uuid().parse(c.req.param("id")), body));
  });
  app.post("/v1/consolidation-groups/:id/eliminate", async (c) => {
    const body = eliminationSchema.parse(await c.req.json());
    return c.json(await program.eliminateGroup(readActor(c), z.uuid().parse(c.req.param("id")), body));
  });
  app.post("/v1/models", async (c) => {
    const body = modelSchema.parse(await c.req.json());
    return c.json(await program.createModel(readActor(c), body), 201);
  });
  app.post("/v1/models/:id/versions", async (c) => {
    const body = modelVersionSchema.parse(await c.req.json());
    return c.json(await program.saveModelVersion(readActor(c), z.uuid().parse(c.req.param("id")), body.nodes as CalcNode[]), 201);
  });
  app.post("/v1/models/:id/calculate", async (c) => {
    const body = modelVersionSchema.parse(await c.req.json());
    return c.json(await program.calculateModel(readActor(c), z.uuid().parse(c.req.param("id")), body.nodes as CalcNode[]));
  });
  app.post("/v1/scenarios", async (c) => {
    const body = scenarioSchema.parse(await c.req.json());
    return c.json(await program.createScenario(readActor(c), body), 201);
  });
  app.post("/v1/valuations", async (c) => {
    const body = dcfSchema.parse(await c.req.json());
    return c.json(await program.createValuation(readActor(c), body), 201);
  });
  app.post("/v1/valuations/:id/transition", async (c) => {
    const body = transitionSchema.parse(await c.req.json());
    return c.json(await program.transitionValuation(readActor(c), z.uuid().parse(c.req.param("id")), body.to));
  });
  app.post("/v1/valuations/:id/calculate", async (c) => {
    const valuationId = z.uuid().parse(c.req.param("id"));
    const body = sensitivitySchema.parse(await c.req.json());
    const current = await program.getValuation(readActor(c), valuationId);
    return c.json(await program.sensitivity(readActor(c), { base: current.base, shocks: body.shocks }));
  });
  app.post("/v1/report-packs", async (c) => {
    const body = reportPackSchema.parse(await c.req.json());
    return c.json(await program.createReportPack(readActor(c), body), 201);
  });
  app.get("/v1/report-packs/:id", async (c) => {
    return c.json(await program.getReportPack(readActor(c), z.uuid().parse(c.req.param("id"))));
  });
  app.post("/v1/capital/debt", async (c) => {
    const body = debtSchema.parse(await c.req.json());
    return c.json(await program.rollDebt(readActor(c), body), 201);
  });
  app.post("/v1/capital/cap-table", async (c) => {
    const body = capTableSchema.parse(await c.req.json());
    return c.json(await program.capTable(readActor(c), body), 201);
  });
  app.post("/v1/capital/sources-uses", async (c) => {
    const body = sourcesUsesSchema.parse(await c.req.json());
    return c.json(await program.sourcesUses(readActor(c), body));
  });
  app.post("/v1/capital/lbo", async (c) => {
    const body = lboSchema.parse(await c.req.json());
    return c.json(await program.lbo(readActor(c), body));
  });
  app.post("/v1/imports", async (c) => {
    const body = importSchema.parse(await c.req.json());
    const result = await program.importBatch(readActor(c), body);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post("/v1/qoe", async (c) => {
    const body = qoeSchema.parse(await c.req.json());
    return c.json(await program.qoe(readActor(c), body));
  });
  app.post("/v1/proposals", async (c) => {
    const body = proposalSchema.parse(await c.req.json());
    return c.json(await program.propose(readActor(c), body), 201);
  });
  app.post("/v1/proposals/accept", async (c) => {
    const body = acceptProposalSchema.parse(await c.req.json());
    return c.json(await program.acceptProposal(readActor(c), body));
  });
  app.post("/v1/deals", async (c) => {
    const body = dealSchema.parse(await c.req.json());
    return c.json(await program.createDeal(readActor(c), body), 201);
  });
  app.post("/v1/reporting-bases", async (c) => {
    const body = basisSchema.parse(await c.req.json());
    return c.json(await program.mapBasis(readActor(c), body), 201);
  });
  app.post("/v1/ownership", async (c) => {
    const body = ownershipSchema.parse(await c.req.json());
    return c.json(await program.recordOwnership(readActor(c), body), 201);
  });
}
