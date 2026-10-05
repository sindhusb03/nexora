import { encodeGrid } from "./adversarial-corpus.js";

// Authored truth, independent of parsing. All dates and decimal values are literal.
type Case = {
  id: string;
  language: string;
  format: "csv" | "xlsx" | "pdf";
  title: string;
  headers: string[];
  periods: ([string, string] | null)[];
};
const calendar: [string, string] = ["2024-01-01", "2024-12-31"];
const march: [string, string] = ["2024-04-01", "2025-03-31"];
const priorCalendar: [string, string] = ["2023-01-01", "2023-12-31"];
const cases: Case[] = [
  {
    id: "en-shared-year",
    language: "EN",
    format: "csv",
    title: "",
    headers: ["February - January 2024"],
    periods: [null],
  },
  {
    id: "en-full-months",
    language: "EN",
    format: "xlsx",
    title: "",
    headers: ["January - December 2024"],
    periods: [calendar],
  },
  {
    id: "en-short-months",
    language: "EN",
    format: "pdf",
    title: "",
    headers: ["Jan-Dec 2024"],
    periods: [calendar],
  },
  {
    id: "en-two-years",
    language: "EN",
    format: "csv",
    title: "",
    headers: ["April 2024 - March 2025"],
    periods: [march],
  },
  {
    id: "en-to",
    language: "EN",
    format: "xlsx",
    title: "",
    headers: ["Apr 2024 to Mar 2025"],
    periods: [march],
  },
  {
    id: "en-through",
    language: "EN",
    format: "pdf",
    title: "January through December, 2024",
    headers: ["Total"],
    periods: [calendar],
  },
  {
    id: "de-shared-day-year",
    language: "DE",
    format: "xlsx",
    title: "",
    headers: ["1. Januar bis 31. Dezember 2024"],
    periods: [calendar],
  },
  {
    id: "de-numeric",
    language: "DE",
    format: "csv",
    title: "",
    headers: ["01.01.2024 - 31.12.2024"],
    periods: [calendar],
  },
  {
    id: "de-fiscal",
    language: "DE",
    format: "xlsx",
    title: "zum 31.12.2024",
    headers: ["Geschäftsjahr 2024", "GJ 2023"],
    periods: [calendar, priorCalendar],
  },
  {
    id: "fr-range",
    language: "FR",
    format: "csv",
    title: "",
    headers: ["du 1er janvier au 31 décembre 2024"],
    periods: [calendar],
  },
  {
    id: "fr-fiscal",
    language: "FR",
    format: "xlsx",
    title: "au 31 décembre 2024",
    headers: ["Exercice 2024", "Exercice 2023"],
    periods: [calendar, priorCalendar],
  },
  {
    id: "fr-ended",
    language: "FR",
    format: "csv",
    title: "",
    headers: ["Exercice clos le 31/12/2024"],
    periods: [calendar],
  },
  {
    id: "es-range",
    language: "ES",
    format: "xlsx",
    title: "",
    headers: ["Del 1 de enero al 31 de diciembre de 2024"],
    periods: [calendar],
  },
  {
    id: "es-fiscal",
    language: "ES",
    format: "pdf",
    title: "al 31 de diciembre de 2024",
    headers: ["Ejercicio 2024", "Ejercicio 2023"],
    periods: [calendar, priorCalendar],
  },
  {
    id: "es-ended",
    language: "ES",
    format: "csv",
    title: "",
    headers: ["Ejercicio terminado el 31 de diciembre de 2024"],
    periods: [calendar],
  },
  {
    id: "it-fiscal",
    language: "IT",
    format: "pdf",
    title: "As at 31 March 2025",
    headers: ["Esercizio 2025", "Esercizio 2024"],
    periods: [march, ["2023-04-01", "2024-03-31"]],
  },
  {
    id: "pt-fiscal",
    language: "PT",
    format: "xlsx",
    title: "Fiscal year ended June 30, 2024",
    headers: ["Exercício 2024"],
    periods: [["2023-07-01", "2024-06-30"]],
  },
  {
    id: "nl-fiscal",
    language: "NL",
    format: "pdf",
    title: "As at 30 September 2024",
    headers: ["Boekjaar 2024"],
    periods: [["2023-10-01", "2024-09-30"]],
  },
  {
    id: "ja-range",
    language: "JA",
    format: "csv",
    title: "",
    headers: ["2024年1月1日から2024年12月31日"],
    periods: [calendar],
  },
  {
    id: "ja-fiscal",
    language: "JA",
    format: "xlsx",
    title: "2025年3月31日現在",
    headers: ["2025年度", "2024年度"],
    periods: [march, ["2023-04-01", "2024-03-31"]],
  },
  {
    id: "ja-from-to",
    language: "JA",
    format: "xlsx",
    title: "",
    headers: ["自 2024年4月1日 至 2025年3月31日"],
    periods: [march],
  },
  {
    id: "bare-fiscal-trap",
    language: "ES",
    format: "csv",
    title: "",
    headers: ["Ejercicio 2024"],
    periods: [null],
  },
  {
    id: "conflicting-range-trap",
    language: "EN",
    format: "xlsx",
    title: "As at 30 June 2024",
    headers: ["January - December 2024"],
    periods: [null],
  },
  {
    id: "printed-trap",
    language: "FR",
    format: "csv",
    title: "Printed on 31 December 2024",
    headers: ["Exercice 2024"],
    periods: [null],
  },
  {
    id: "n-comparative",
    language: "FR",
    format: "pdf",
    title: "As at 31 December 2024",
    headers: ["N", "N-1"],
    periods: [calendar, priorCalendar],
  },
  {
    id: "bare-years",
    language: "EN",
    format: "xlsx",
    title: "As at 31 December 2024",
    headers: ["2024", "2023"],
    periods: [calendar, priorCalendar],
  },
  {
    id: "interim-trap",
    language: "EN",
    format: "csv",
    title: "Quarter ended 31 December 2024",
    headers: ["2024", "2023"],
    periods: [null, null],
  },
  {
    id: "printed-as-of-trap",
    language: "EN",
    format: "pdf",
    title: "Printed as of 31 December 2024",
    headers: ["FY 2024"],
    periods: [null],
  },
  {
    id: "explicit-prior-start",
    language: "EN",
    format: "xlsx",
    title: "",
    headers: ["April (previous year) - March 2025"],
    periods: [march],
  },
  {
    id: "fiscal-end-line",
    language: "EN",
    format: "csv",
    title: "Fiscal year end: 30 September",
    headers: ["FY 2024", "FY 2023"],
    periods: [
      ["2023-10-01", "2024-09-30"],
      ["2022-10-01", "2023-09-30"],
    ],
  },
  {
    id: "conflicting-flow-calendars",
    language: "EN",
    format: "xlsx",
    title: "Year ended 31 December 2024",
    headers: ["Jan-Dec 2024", "April 2023 - March 2024"],
    periods: [null, null],
  },
  {
    id: "short-range-trap",
    language: "FR",
    format: "csv",
    title: "",
    headers: ["du 1er janvier au 31 mars 2024"],
    periods: [null],
  },
  {
    id: "non-month-end-trap",
    language: "EN",
    format: "xlsx",
    title: "",
    headers: ["1 January 2024 - 30 December 2024"],
    periods: [null],
  },
  {
    id: "ambiguous-year-title-trap",
    language: "EN",
    format: "pdf",
    title: "April - March 2025",
    headers: ["Total"],
    periods: [null],
  },
];

export function periodHeaderCorpus() {
  return cases.map((c) => ({
    ...c,
    fileName: `${c.id}.${c.format}`,
    bytes: encodeGrid(
      [
        ["Income Statement"],
        ["Currency USD"],
        ...(c.title ? [[c.title]] : []),
        ["Account", ...c.headers],
        [
          "Revenue",
          ...c.headers.map((_, i) =>
            ["DE", "FR"].includes(c.language)
              ? i === 0
                ? "1478,25"
                : "1327,75"
              : i === 0
                ? "1478.25"
                : "1327.75",
          ),
        ],
        [
          "Rent expense",
          ...c.headers.map((_, i) =>
            ["DE", "FR"].includes(c.language)
              ? i === 0
                ? "218,50"
                : "192,25"
              : i === 0
                ? "218.50"
                : "192.25",
          ),
        ],
      ],
      c.format,
      "Income",
    ),
    cells: c.headers.length * 2,
  }));
}
