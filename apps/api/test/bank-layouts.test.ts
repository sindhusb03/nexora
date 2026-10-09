import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticalDecimal } from "@nexora/kernel";
import { selectDocumentParser } from "../src/imports/document-parser.js";
import { parseBankText, parseBankPdfLines } from "../src/imports/bank-tabular.js";
import { bankLayoutCorpus } from "./fixtures/bank-layout-corpus.js";
import { call, sessions, testApp, type TestApp } from "./harness.js";

const corpus = bankLayoutCorpus();
const scores: Record<
  string,
  { cells: number; correct: number; wrong: number; reviewHeld: number }
> = {};
describe("round 4B synthetic bank layout goldens", () => {
  it.each(corpus)("exact amount/date/direction/currency or review: $id", async (fixture) => {
    const result = await selectDocumentParser(fixture.fileName, fixture.bytes).parse(fixture);
    const actual = result.cells.map((c) => [
      c.label,
      new AnalyticalDecimal(c.amount).toFixed(),
      c.txnDate,
    ]);
    const correct = actual.filter((a) =>
      fixture.facts.some((f) => JSON.stringify(f) === JSON.stringify(a)),
    ).length;
    scores[fixture.id] = {
      cells: fixture.facts.length,
      correct,
      wrong: actual.length - correct,
      reviewHeld: Number(result.issues.length > 0),
    };
    if (fixture.issue) expect(result.issues.map((i) => i.code)).toContain(fixture.issue);
    else expect(result.issues).toEqual([]);
    expect(actual).toEqual(fixture.facts);
    for (const [index, cell] of result.cells.entries()) {
      expect(cell.currency).toBe(fixture.currency);
      expect(new AnalyticalDecimal(cell.amount).isNegative()).toBe(
        new AnalyticalDecimal(fixture.facts[index]![1]).isNegative(),
      );
      expect(cell.statementType).toBe("bank");
      expect(cell.balanceKind).toBe(
        cell.label === "Opening balance"
          ? "opening"
          : cell.label === "Closing balance"
            ? "closing"
            : "movement",
      );
      expect(cell.rawText).not.toBe("");
      if (fixture.fileName.endsWith(".pdf")) expect(cell.page).toBeGreaterThan(0);
    }
  });
  afterAll(() => console.table(scores));
});

describe("bank uploads preserve values and traps persist open exceptions without auto-posts", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await testApp();
    await sessions(app).register("platform-admin", "owner-1");
  });
  it.each(corpus)("upload safety: $id", async (fixture) => {
    const response = await call(app, "POST", "/v1/tenants", {
      actor: "platform-admin",
      region: "us-east-1",
      body: { name: fixture.id, homeRegion: "us-east-1", ownerActorId: "owner-1" },
    });
    expect(response.status).toBe(201);
    const { tenantId } = (await response.json()) as { tenantId: string };
    const options = { actor: "owner-1", tenant: tenantId, region: "us-east-1" };
    const entityResponse = await call(app, "POST", "/v1/entities", {
      ...options,
      body: { legalName: fixture.id, functionalCurrency: fixture.currency },
    });
    expect(entityResponse.status).toBe(201);
    const { entityId } = (await entityResponse.json()) as { entityId: string };
    const session = await sessions(app).session("owner-1", "us-east-1", tenantId);
    if (session instanceof Response) throw new Error("Missing session");
    const form = new FormData();
    form.set("entityId", entityId);
    form.set("file", new File([Buffer.from(fixture.bytes)], fixture.fileName));
    const upload = await app.request("/ingestion/uploads", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "idempotency-key": fixture.id,
      },
      body: form,
    });
    expect(upload.status).toBe(201);
    const job = (await upload.json()) as { jobId: string; status: string };
    expect(job.status).toBe("needs_review");
    const exceptions = await call(app, "GET", `/ingestion/jobs/${job.jobId}/exceptions`, options);
    if (fixture.issue)
      expect(await exceptions.json()).toMatchObject({
        exceptions: expect.arrayContaining([
          expect.objectContaining({ type: fixture.issue, status: "open" }),
        ]),
      });
    const valuesResponse = await call(app, "GET", `/ingestion/jobs/${job.jobId}/values`, options);
    const { values } = (await valuesResponse.json()) as {
      values: { label: string; minor: string; currency: string }[];
    };
    expect(values.map((v) => [v.label, v.minor, v.currency])).toEqual(
      fixture.facts.map(([label, amount]) => [
        label,
        new AnalyticalDecimal(amount).mul(fixture.currency === "JPY" ? "1" : "100").toFixed(0),
        fixture.currency,
      ]),
    );
    const journals = await call(app, "GET", `/v1/entities/${entityId}/journals`, options);
    expect(await journals.json()).toMatchObject({ journals: [] });
  });
});

describe("generic held-out bank layouts", () => {
  it("reads a bare Value as signed amount and keeps Value date distinct from Amount", () => {
    const signed = parseBankText(
      [
        "Currency: GBP",
        "Date,Description,Value,Balance",
        ",Opening balance,,2500.00",
        "2024-12-13,Water,-92.10,2407.90",
        "2024-12-14,Receipt,20.00,2427.90",
        ",Closing balance,,2427.90",
      ].join("\n"),
    );
    expect(signed.issues).toEqual([]);
    expect(signed.bank?.transactions.map((t) => [t.date, t.amount])).toEqual([
      ["2024-12-13", "-92.10"],
      ["2024-12-14", "20.00"],
    ]);
    const dated = parseBankText(
      [
        "Currency: GBP",
        "Value date,Description,Amount,Balance",
        ",Opening balance,,2500.00",
        "2024-12-13,Water,-92.10,2407.90",
        "2024-12-14,Receipt,20.00,2427.90",
        ",Closing balance,,2427.90",
      ].join("\n"),
    );
    expect(dated.issues).toEqual([]);
    expect(dated.bank?.transactions.map((t) => [t.date, t.amount])).toEqual([
      ["2024-12-13", "-92.10"],
      ["2024-12-14", "20.00"],
    ]);
  });
  it("reads signed Value headers, strips narration apostrophes and leaves summaries absent", () => {
    for (const header of ["Value", "Bedrag", "Betrag", "Importe", "Montant"]) {
      const result = parseBankText(
        [
          "Currency: GBP",
          `Date,Type,Description,${header},Balance,Account Name,Account Number`,
          "2024-12-13,D/D,'THAMES WATER,-92.10,2407.90,Current,12345678",
          "2024-12-14,POS,'SHOP,-45.00,2362.90,Current,12345678",
          "2024-12-15,BAC,'ELM STREET VETS LTD,-10.00,2352.90,Current,12345678",
          "2024-12-16,OTR,'TRANSFER,20.00,2372.90,Current,12345678",
        ].join("\n"),
      );
      expect(result.bank?.opening).toBeNull();
      expect(result.bank?.closing).toBeNull();
      expect(result.bank?.transactions.map((t) => [t.description, t.amount, t.date])).toEqual([
        ["D/D THAMES WATER", "-92.10", "2024-12-13"],
        ["POS SHOP", "-45.00", "2024-12-14"],
        ["BAC ELM STREET VETS LTD", "-10.00", "2024-12-15"],
        ["OTR TRANSFER", "20.00", "2024-12-16"],
      ]);
      expect(result.issues.every((i) => i.code === "balance_mismatch")).toBe(true);
      const broken = parseBankText(
        [
          `Date,Description,${header},Balance`,
          "2024-12-13,Water,-92.10,2407.90",
          "2024-12-14,Shop,-45.00,2363.90",
        ].join("\n"),
      );
      expect(broken.issues.some((i) => i.message.includes("Running balance"))).toBe(true);
      expect(broken.bank?.transactions.map((t) => t.description)).toEqual(["Water", "Shop"]);
    }
  });
  it("does not prefix a Starling transaction with a long Type value", () => {
    const result = parseBankText(
      [
        "Currency: GBP",
        "Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)",
        "2024-12-13,Acme,Invoice 123,FASTER PAYMENT,-92.10,2407.90",
      ].join("\n"),
    );
    expect(result.bank?.transactions[0]?.description).toBe("Acme");
  });
  it("reads Dutch explicit signs and decimal commas with counterparty and description", () => {
    const result = parseBankText(
      [
        '"IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag","Saldo na trn","Naam tegenpartij","Omschrijving-1"',
        '"NL00TEST0123456789","EUR","TESTNL2A","1","13-12-2024","13-12-2024","-151,24","9.848,76","Eneco Services","Termijnbedrag mei"',
        '"NL00TEST0123456789","EUR","TESTNL2A","2","14-12-2024","14-12-2024","+4.818,00","14.666,76","Albert Heijn 1102","Betaalautomaat 14:22 pasnr. 012"',
        '"NL00TEST0123456789","EUR","TESTNL2A","3","15-12-2024","15-12-2024","+28.945,26","43.612,02","Other client",""',
      ].join("\n"),
    );
    expect(result.bank?.opening).toBeNull();
    expect(result.bank?.closing).toBeNull();
    expect(result.bank?.transactions.map((t) => [t.description, t.amount, t.date])).toEqual([
      ["Eneco Services Termijnbedrag mei", "-151.24", "2024-12-13"],
      ["Albert Heijn 1102 Betaalautomaat 14:22 pasnr. 012", "4818.00", "2024-12-14"],
      ["Other client", "28945.26", "2024-12-15"],
    ]);
  });
  it("reads Swiss preamble balances and posting dates with apostrophe grouping", () => {
    const result = parseBankText(
      [
        "Anfangssaldo:;38'958.97",
        "Schlusssaldo:;44'422.87",
        "Bewertet in:;CHF",
        "Abschlussdatum;Buchungsdatum;Valuta;Währung;Belastung;Gutschrift;Saldo;Beschreibung",
        "2024-12-31;13-12-2024;14-12-2024;CHF;;5'463.90;44'422.87;Receipt",
      ].join("\n"),
    );
    expect(result.issues).toEqual([]);
    expect([result.bank?.opening, result.bank?.closing]).toEqual(["38958.97", "44422.87"]);
    expect(result.bank?.transactions.map((t) => [t.description, t.amount, t.date])).toEqual([
      ["Receipt", "5463.90", "2024-12-13"],
    ]);
  });
  it("reads PDF B/F and C/F, carries reconciled dates and appends wrapped narration", () => {
    const rows = [
      ["Currency: INR"],
      ["Date", "Description", "Chq.No", "Debit", "Credit", "Balance"],
      ["", "B/F", "", "", "", "1,34,146.57"],
      ["13-12-2024", "Cheque payment", "987654", "1,000.00", "", "1,33,146.57"],
      ["", "wrapped narration", "", "", "", ""],
      ["", "Receipt", "", "", "2,000.00", "1,35,146.57"],
      ["", "C/F", "", "", "", "1,35,146.57"],
    ];
    const lines = rows.map((row, r) => ({
      page: 1,
      y: 700 - r * 10,
      items: row.flatMap((text, c) =>
        text ? [{ text, x: [30, 130, 310, 410, 510, 610][c]!, y: 700 - r * 10 }] : [],
      ),
    }));
    const result = parseBankPdfLines(lines);
    expect(result.issues).toEqual([]);
    expect([result.bank?.opening, result.bank?.closing]).toEqual(["134146.57", "135146.57"]);
    expect(result.bank?.transactions.map((t) => [t.description, t.amount, t.date])).toEqual([
      ["Cheque payment wrapped narration", "-1000.00", "2024-12-13"],
      ["Receipt", "2000.00", "2024-12-13"],
    ]);
    const broken = parseBankPdfLines(
      lines.map((l, r) =>
        r === 5
          ? {
              ...l,
              items: l.items.map((i) => (i.x === 610 ? { ...i, text: "1,35,147.57" } : i)),
            }
          : l,
      ),
    );
    expect(broken.bank).toBeNull();
    expect(broken.issues.map((i) => i.code)).toContain("balance_mismatch");
  });
});
