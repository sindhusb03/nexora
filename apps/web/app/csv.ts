/** CSV source syntax only: the server remains authoritative for imported amounts. */
export function splitCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === delimiter || char === "\r" || char === "\n") {
      row.push(cell);
      cell = "";
      closed = false;
      if (char !== delimiter) {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        if (row.some((value) => value.trim().length > 0)) rows.push(row);
        row = [];
      }
    } else if (char === '"' && cell.length === 0 && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Malformed CSV quoting; review the source file.");
      cell += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote; review the source file.");
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): string {
  const counts = new Map([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === "\r" || char === "\n") break;
      if (counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

export type AmountResult =
  { ok: true; minor: string; scale: number } | { ok: false; reason: string };

/** decimal-text-v1. CR is positive, DR is negative; conflicting sign markers require review. */
export function parseAmount(text: string, options: { decimal: "." | "," | "auto" }): AmountResult {
  let body = text.trim();
  let negative = false;
  let signs = 0;
  const invalid = (reason: string): AmountResult => ({ ok: false, reason });
  const suffix = /\s*(CR|DR)$/i.exec(body);
  if (suffix) {
    negative = suffix[1]?.toUpperCase() === "DR";
    signs += 1;
    body = body.slice(0, suffix.index).trim();
  }
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    signs += 1;
    body = body.slice(1, -1).trim();
  }
  const stripSign = () => {
    if (body.startsWith("-")) {
      signs += 1;
      negative = true;
      body = body.slice(1).trim();
    }
    if (body.endsWith("-")) {
      signs += 1;
      negative = true;
      body = body.slice(0, -1).trim();
    }
  };
  stripSign();
  body = body.replace(/^(?:\p{Sc}|[A-Z]{3})\s*/u, "");
  stripSign();
  if (signs > 1) return invalid("Conflicting sign markers");
  if (!/^\d[\d.,]*$/.test(body)) return invalid("Invalid amount syntax");
  let decimal: "." | "," | null = options.decimal === "auto" ? null : options.decimal;
  if (options.decimal === "auto") {
    if (body.includes(".") && body.includes(",")) {
      decimal = body.lastIndexOf(".") > body.lastIndexOf(",") ? "." : ",";
    } else if (body.includes(".")) {
      if ((body.match(/\./g) ?? []).length === 1) {
        if (body.split(".")[1]?.length === 3)
          return invalid("Ambiguous decimal or thousands separator");
        decimal = ".";
      }
    } else if ((body.match(/,/g) ?? []).length === 1) {
      return invalid("Ambiguous decimal or thousands separator");
    }
  }
  const parts = decimal ? body.split(decimal) : [body];
  if (parts.length > 2) return invalid("Multiple decimal separators");
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (parts.length === 2 && !/^\d+$/.test(fraction)) return invalid("Invalid fractional digits");
  const group = decimal === "," ? "." : decimal === "." ? "," : body.includes(",") ? "," : ".";
  const groups = whole.split(group);
  if (groups.length > 1) {
    const western =
      /^\d{1,3}$/.test(groups[0] ?? "") && groups.slice(1).every((part) => /^\d{3}$/.test(part));
    const indian =
      /^\d{1,2}$/.test(groups[0] ?? "") &&
      /^\d{3}$/.test(groups.at(-1) ?? "") &&
      groups.slice(1, -1).every((part) => /^\d{2}$/.test(part));
    if (!western && !indian) return invalid("Invalid thousands grouping");
  }
  const digits = groups.join("");
  if (!/^\d+$/.test(digits)) return invalid("Invalid integer digits");
  const minor = BigInt(digits + fraction) * (negative ? -1n : 1n);
  return { ok: true, minor: minor.toString(), scale: fraction.length };
}

/** Exact decimal string for submission, preserving the source scale. */
export function amountDecimal(amount: Extract<AmountResult, { ok: true }>): string {
  const negative = amount.minor.startsWith("-");
  const digits = (negative ? amount.minor.slice(1) : amount.minor).padStart(amount.scale + 1, "0");
  return `${negative ? "-" : ""}${amount.scale ? `${digits.slice(0, -amount.scale)}.${digits.slice(-amount.scale)}` : digits}`;
}
