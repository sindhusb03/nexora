import type { StatementType } from "./statement-xlsx.js";
import type { AmountScale } from "@nexora/kernel";

/** Phrase tables shared by tabular and text-PDF readers. */
const TITLES: readonly [StatementType, RegExp][] = [
  [
    "income_statement",
    /compte de r[ée]sultat|gewinn[-\s]+und verlustrechnung|cuenta de p[ée]rdidas y ganancias|損益計算書|statement of profit and loss|conto economico|winst[-\s]+en[-\s]+verliesrekening|jaarrekening|demonstra[cç][aã]o do resultado(?: do exerc[ií]cio)?|\bDRE\b/i,
  ],
  ["balance_sheet", /\bbilan\b|\bbilanz\b|balance de situaci[oó]n|貸借対照表/i],
];
export function localizedStatementType(text: string): StatementType | null {
  const types = new Set(TITLES.filter(([, pattern]) => pattern.test(text)).map(([type]) => type));
  return types.size === 1 ? [...types][0]! : null;
}

export function annotationHeader(text: string): boolean {
  return /^(?:notes?(?:\s+no\.?)?|sch|schedule|ref(?:erence)?s?|sr|remarks|units?|codes?|références?|réf\.?|annexe|anhang|nr\.?|notas?|código|referencia|注記|参照|番号)$/i.test(
    text.trim(),
  );
}

export function nonPeriodHeader(text: string): boolean {
  return (
    annotationHeader(text) ||
    /\b(?:gross|accumulated|brut|brutto|amortissements cumulés|abschreibungen kumuliert|cost|codes?|references?)\b|取得原価|減価償却累計額/i.test(
      text,
    )
  );
}

const SCALES: readonly [AmountScale, RegExp][] = [
  ["crores", /\bcrores?\b/i],
  ["lakhs", /\blakhs?\b|\blacs?\b/i],
  ["millions", /[£$€]\s*m\b|\bmillion|百万円|\bMio\.?\s*(?:EUR|Euro)/i],
  [
    "thousands",
    /\bthousands?\b|\b000s\b|['’]000|千円|\(\s*(?:(?:USD|GBP|EUR|INR|SGD|AED|JPY|AUD)\s*)?000\s*\)|\bmilliers\b|\bTausend\b|\bTEUR\b|\bmiles de euros\b|\b(?:importi|valori) in migliaia di euro\b|\bx\s*(?:€|EUR)?\s*1\.000\b|\bem milhares de reais\b|R\$\s*mil\b/i,
  ],
  [
    "units",
    /amounts in units|figures in units|\bvalori in euro\b|\bbedragen in euro\b|\ben euros\b|\bin Euro\b|単位\s*[:：]?\s*円(?:\s|$|[)）])/i,
  ],
];
export function statementScales(text: string): AmountScale[] {
  return SCALES.filter(([, pattern]) => pattern.test(text)).map(([scale]) => scale);
}

export function unknownScale(text: string): boolean {
  // Bare currency-denominated amounts are units; an explicit but unsupported
  // unit declaration cannot silently inherit that default.
  return text
    .split(/[\n\t]/)
    .some(
      (line) =>
        /\b(?:amounts|figures)\s+in\b|\b(?:en|in)\s+(?:centaines|hundert|hundreds|billions?|trillions?)\b|単位\s*[:：]/i.test(
          line,
        ) &&
        statementScales(line).length === 0 &&
        !/\b(?:amounts|figures)\s+in\s+(?:USD|EUR|GBP|INR|JPY|AUD|SGD|AED)\s*$/i.test(line),
    );
}

/** A lone amount column can borrow an explicit statement title period. */
export function localizedAmountHeader(text: string): boolean {
  return /^(?:amount|total|importe|monto|金額|[$€£¥₹])$/i.test(text.trim());
}
