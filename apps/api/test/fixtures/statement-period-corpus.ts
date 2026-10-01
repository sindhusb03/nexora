import { encodeGrid } from "./adversarial-corpus.js";

// Synthetic source documents and independently specified truth. No parser-derived expectations.
export function statementPeriodCorpus() {
  const cases: {
    id: string;
    title: string;
    headers: string[];
    ends: (string | null)[];
    format?: "xlsx" | "csv" | "pdf";
    footer?: string;
    yearEnd?: { month: number; day: number };
    titleInHeader?: boolean;
    titleColumn?: boolean;
    above?: string[];
  }[] = [
    {
      id: "long-range",
      title: "January 1, 2024 - December 31, 2024",
      headers: ["Selected Period"],
      ends: ["2024-12-31"],
    },
    {
      id: "month-range",
      title: "July 2024 To June 2025",
      headers: ["Total"],
      ends: ["2025-06-30"],
    },
    {
      id: "numeric-dmy",
      title: "From 01/04/2024 To 31/03/2025",
      headers: ["Amount"],
      ends: ["2025-03-31"],
    },
    {
      id: "numeric-mdy",
      title: "From 07/01/2024 To 06/30/2025",
      headers: ["Balance"],
      ends: ["2025-06-30"],
    },
    { id: "en-dash", title: "1 Jul 2024 – 30 Jun 2025", headers: ["Total"], ends: ["2025-06-30"] },
    {
      id: "hyphen-month",
      title: "1-Oct-2024 to 30-Sep-2025",
      headers: ["Amount"],
      ends: ["2025-09-30"],
    },
    {
      id: "german-range",
      title: "Zeitraum vom 1. Januar 2024 bis 31. Dezember 2024",
      headers: ["Total"],
      ends: ["2024-12-31"],
      format: "xlsx",
    },
    {
      id: "french-range",
      title: "Période du 1 juillet 2024 au 30 juin 2025",
      headers: ["Amount"],
      ends: ["2025-06-30"],
      format: "csv",
    },
    {
      id: "spanish-range",
      title: "Periodo del 1 de enero de 2024 al 31 de diciembre de 2024",
      headers: ["Total"],
      ends: ["2024-12-31"],
      format: "xlsx",
    },
    {
      id: "japanese-range",
      title: "期間 2024年4月1日から2025年3月31日まで",
      headers: ["Total"],
      ends: ["2025-03-31"],
      format: "csv",
    },
    {
      id: "german-ended",
      title: "Geschäftsjahr zum 30. September 2025",
      headers: ["2025", "2024"],
      ends: ["2025-09-30", "2024-09-30"],
      format: "xlsx",
    },
    {
      id: "french-ended",
      title: "Exercice clos le 31 décembre 2024",
      headers: ["Amount"],
      ends: ["2024-12-31"],
      format: "csv",
    },
    {
      id: "spanish-ended",
      title: "Ejercicio terminado el 31 de diciembre de 2024",
      headers: ["Balance"],
      ends: ["2024-12-31"],
      format: "xlsx",
    },
    {
      id: "japanese-ended",
      title: "2025年3月31日に終了する事業年度",
      headers: ["Selected Period"],
      ends: ["2025-03-31"],
      format: "csv",
    },
    {
      id: "as-at-title",
      title: "As at 31 Dec 2024",
      headers: ["Balance"],
      ends: ["2024-12-31"],
      format: "pdf",
    },
    {
      id: "as-of-columns",
      title: "",
      headers: ["As of June 30, 2025", "As at 31 December 2024"],
      ends: ["2025-06-30", "2024-12-31"],
      format: "pdf",
    },
    {
      id: "fy-four-digit",
      title: "Fiscal year ended September 30,",
      headers: ["FY2025", "FY2024"],
      ends: ["2025-09-30", "2024-09-30"],
    },
    {
      id: "fy-short-range",
      title: "Fiscal year ended March 31,",
      headers: ["FY24-25", "2023-24"],
      ends: ["2025-03-31", "2024-03-31"],
    },
    ...["Year to Date (prior)", "Previous year", "N-1", "Vorjahr"].map((prior, i) => ({
      id: `prior-${i}`,
      title: "Year ended 30 June 2025",
      headers: ["Selected Period", prior],
      ends: ["2025-06-30", "2024-06-30"],
      format: "xlsx" as const,
    })),
    { id: "bare-fy", title: "", headers: ["FY25", "FY24-25", "2024-25"], ends: [null, null, null] },
    {
      id: "org-fy",
      title: "",
      headers: ["FY2025", "FY24"],
      ends: ["2025-08-31", "2024-08-31"],
      yearEnd: { month: 8, day: 31 },
    },
    {
      id: "mixed-interim",
      title: "",
      headers: [
        "Three Months Ended June 30, 2025",
        "Six months ended June 30, 2025",
        "Nine months ended June 30, 2025",
        "Year ended June 30, 2025",
      ],
      ends: [null, null, null, "2025-06-30"],
      format: "xlsx",
    },
    { id: "quarter", title: "Quarter ended 30 September 2025", headers: ["Amount"], ends: [null] },
    {
      id: "run-footer",
      title: "Year ended 31 December 2024",
      headers: ["Amount"],
      ends: ["2024-12-31"],
      footer: "Accrual basis Friday August 15, 2025 10:42 AM",
    },
    {
      id: "printed-only",
      title: "",
      headers: ["FY2025"],
      ends: [null],
      footer: "Printed on September 30, 2025",
    },
    {
      id: "run-only",
      title: "",
      headers: ["FY25"],
      ends: [null],
      footer: "Run date: December 31, 2025",
    },
    {
      id: "basis-only",
      title: "",
      headers: ["FY25"],
      ends: [null],
      footer: "Accrual basis Wednesday December 31, 2025 12:15 PM",
    },
    {
      id: "conflict-title-column",
      title: "Year ended 30 June 2025",
      headers: ["As at 31 December 2025"],
      ends: [null],
    },
    {
      id: "conflict-year",
      title: "Year ended 30 June 2025",
      headers: ["As at 30 June 2024"],
      ends: [null],
    },
    {
      id: "ambiguous-range",
      title: "From 01/02/2024 To 03/04/2025",
      headers: ["Amount"],
      ends: [null],
    },
    {
      id: "undated-comparison",
      title: "",
      headers: ["As at 30 June 2025", "Comparison"],
      ends: ["2025-06-30", null],
    },
    {
      id: "range-column",
      title: "",
      headers: ["January 1, 2024 - December 31, 2024"],
      ends: ["2024-12-31"],
      format: "pdf",
    },
    {
      id: "label-cell-fy",
      title: "Fiscal year ended September 30,",
      titleInHeader: true,
      headers: ["FY2025", "FY2024"],
      ends: ["2025-09-30", "2024-09-30"],
      format: "xlsx",
    },
    {
      id: "prior-dated",
      title: "Year ended 31 December 2025",
      headers: ["Selected Period", "Previous year: As at 31 December 2024"],
      ends: ["2025-12-31", "2024-12-31"],
      format: "csv",
    },
    {
      id: "dmy-column-evidence",
      title: "",
      headers: ["As at 05/04/2025", "As at 31/03/2024"],
      ends: ["2025-04-05", "2024-03-31"],
      format: "xlsx",
    },
    {
      id: "mdy-column-evidence",
      title: "",
      headers: ["As at 04/05/2025", "As at 03/31/2024"],
      ends: ["2025-04-05", "2024-03-31"],
      format: "csv",
    },
    {
      id: "ambiguous-column",
      title: "",
      headers: ["As at 05/04/2025"],
      ends: [null],
      format: "xlsx",
    },
    {
      id: "conflicting-date-order",
      title: "",
      headers: ["As at 05/04/2025", "As at 31/03/2024", "As at 03/31/2023"],
      ends: [null, null, null],
      format: "xlsx",
    },
    {
      id: "french-as-at",
      title: "Bilan au 31 décembre 2024",
      headers: ["Balance"],
      ends: ["2024-12-31"],
      format: "csv",
    },
    {
      id: "spanish-as-at",
      title: "Balance al 31 de diciembre de 2024",
      headers: ["Balance"],
      ends: ["2024-12-31"],
      format: "xlsx",
    },
    {
      id: "japanese-as-at",
      title: "2025年3月31日現在",
      headers: ["Balance"],
      ends: ["2025-03-31"],
      format: "csv",
    },
    {
      id: "title-with-dated-comparative",
      title: "As at 30 June 2025",
      headers: ["As at 30 June 2025", "As at 31 December 2024"],
      ends: ["2025-06-30", "2024-12-31"],
      format: "xlsx",
    },
    {
      id: "stacked-spans",
      title: "",
      above: ["Three Months Ended", "Year ended"],
      headers: ["30 June 2025", "30 June 2025"],
      ends: [null, "2025-06-30"],
      format: "xlsx",
    },
    {
      id: "offset-title-conflict",
      title: "Year ended 30 June 2025",
      titleColumn: true,
      headers: ["As at 31 December 2025"],
      ends: [null],
      format: "xlsx",
    },
    {
      id: "offset-title-period",
      title: "Year ended 30 June 2025",
      titleColumn: true,
      headers: ["Amount"],
      ends: ["2025-06-30"],
      format: "xlsx",
    },
    {
      id: "shared-yearless-header",
      title: "",
      above: ["Fiscal year ended September 30,", ""],
      headers: ["2025", "2024"],
      ends: ["2025-09-30", "2024-09-30"],
      format: "xlsx",
    },
  ];
  return cases.map((c, i) => {
    const format = c.format ?? (["xlsx", "csv", "pdf"] as const)[i % 3]!;
    const rows = [
      ["Income Statement"],
      ["Currency USD"],
      ...(c.title && !c.titleInHeader ? [c.titleColumn ? ["", c.title] : [c.title]] : []),
      ...(c.above ? [["", ...c.above]] : []),
      [c.titleInHeader ? c.title : "Account", ...c.headers],
      ["Revenue", ...c.headers.map((_, col) => `${1200 + col * 100}.25`)],
      ["Rent expense", ...c.headers.map((_, col) => `${200 + col * 10}.50`)],
      ...(c.footer ? [[c.footer]] : []),
    ];
    // Use the printed numeric convention of these localized source documents.
    const localizedRows = /^(german|french)/.test(c.id)
      ? rows.map((row) => row.map((v) => (/^\d+\.\d{2}$/.test(v) ? v.replace(".", ",") : v)))
      : rows;
    return {
      ...c,
      fileName: `${c.id}.${format}`,
      bytes: encodeGrid(localizedRows, format, "Income"),
      cells: c.headers.length * 2,
    };
  });
}
