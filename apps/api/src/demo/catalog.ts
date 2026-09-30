/** Short excerpts from the monthly statement files. The workbooks themselves stay out of git. */
export const SOURCE_DOCUMENTS = [
  {
    slug: "nazareno-income",
    title: "Nazareno Services income statement",
    fileName: "incomeStatement_NazarenoServices.xlsx",
    body: "Monthly income statement for Nazareno Services, an orthotics and prosthetics practice. Source accounts include 4001 Protesis Piernas and Brazos, 4002 Ortosis Manufacturados, 4003 Equipos Ortopedicos, 4004 Zapatos, and 4005 Protesis Breast. The January 2018 piezas line is 286.24. Mapping proposes 4001.1 Piezas to patient services 4000. These workbook figures are evidence, not the ledger.",
  },
  {
    slug: "nazareno-balance",
    title: "Nazareno Services balance sheet",
    fileName: "balanceSheet_NazarenoServices.xlsx",
    body: "Monthly balance sheet workbook for Nazareno Services. Cash, receivables, equipment, payables, and the term loan are mapped into the chart before any journal is posted. The reconciliation certificate compares this file's cash to the kernel cash balance.",
  },
  {
    slug: "bank-statements",
    title: "Operating bank statements",
    fileName: "bank_statements/file.pdf",
    body: "Twelve operating-account bank statement PDFs were staged for Nazareno Services, named file.pdf through file (11).pdf. They support the cash reconciliation. The kernel cash balance remains the book figure. A printed statement page is not the cash-flow statement.",
  },
  {
    slug: "board-minutes",
    title: "Board minutes excerpt",
    fileName: "board-minutes-2026-09.txt",
    body: "September 2026 board note. Management will keep the company board-ready and deal-ready. Normalized EBITDA add-backs under review are owner personal travel and a one-time litigation matter. No add-back is posted to the ledger. Supervised autonomy: agents propose, the controller approves.",
  },
] as const;
