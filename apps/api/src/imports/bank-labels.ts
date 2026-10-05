/** Semantic column labels, shared across formats; never institution-specific. */
export function bankLabel(value: string): string {
  const text = value.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const labels: Readonly<Record<string, string>> = {
    buchungstag: "Posting date",
    valuta: "Value date",
    verwendungszweck: "Description",
    soll: "Debit",
    haben: "Credit",
    saldo: "Balance",
    "date operation": "Date",
    libelle: "Description",
    debit: "Debit",
    credit: "Credit",
    solde: "Balance",
    fecha: "Date",
    concepto: "Description",
    cargo: "Debit",
    abono: "Credit",
    data: "Date",
    descricao: "Description",
    debito: "Debit",
    credito: "Credit",
    "data contabile": "Posting date",
    descrizione: "Description",
    addebiti: "Debit",
    accrediti: "Credit",
    boekdatum: "Posting date",
    valutadatum: "Value date",
    omschrijving: "Description",
    af: "Debit",
    bij: "Credit",
    取引日: "Date",
    お取引日: "Date",
    日付: "Date",
    年月日: "Date",
    取引年月日: "Date",
    記帳日: "Posting date",
    起算日: "Value date",
    摘要: "Description",
    内容: "Description",
    取引内容: "Description",
    お取引内容: "Description",
    出金: "Debit",
    出金額: "Debit",
    支払金額: "Debit",
    お支払金額: "Debit",
    お支払い金額: "Debit",
    引出金額: "Debit",
    お引出し: "Debit",
    お引出し金額: "Debit",
    払戻金額: "Debit",
    入金: "Credit",
    入金額: "Credit",
    預入金額: "Credit",
    お預り金額: "Credit",
    お預かり金額: "Credit",
    お預け入れ金額: "Credit",
    お預入れ: "Credit",
    お預け入れ: "Credit",
    残高: "Balance",
    差引残高: "Balance",
    ご預金残高: "Balance",
    お預り残高: "Balance",
    金額: "Amount",
    anfangssaldo: "Opening Balance",
    "solde precedent": "Opening Balance",
    "saldo anterior": "Opening Balance",
    "saldo inicial": "Opening Balance",
    "saldo iniziale": "Opening Balance",
    beginsaldo: "Opening Balance",
    "b/f": "Opening Balance",
    前月繰越: "Opening Balance",
    前日繰越: "Opening Balance",
    繰越残高: "Opening Balance",
    endsaldo: "Closing Balance",
    "solde final": "Closing Balance",
    "saldo final": "Closing Balance",
    "saldo finale": "Closing Balance",
    eindsaldo: "Closing Balance",
    次月繰越: "Closing Balance",
  };
  if (labels[text]) return labels[text]!;
  // Denominations and inline printed summary amounts may follow a label.
  const prefix = Object.keys(labels)
    .sort((a, b) => b.length - a.length)
    .find(
      (label) =>
        text.startsWith(label) &&
        /^(?:\s*[:=(]|\s+(?:[\d￥¥€£]|(?:JPY|EUR|USD|GBP)\b))/i.test(text.slice(label.length)),
    );
  return prefix ? labels[prefix]! + text.slice(prefix.length) : value;
}

export function bankDateToken(raw: string, context: string): string {
  let text = raw.normalize("NFKC").trim();
  text = text.replace(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日$/, "$1-$2-$3");
  const era = /^R(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/i.exec(text);
  // An abbreviated era must be declared by the source, not inferred from market.
  if (era && /Era rule:\s*R\s*=\s*Reiwa;\s*year\s*=\s*2018\s*\+\s*era year/i.test(context)) {
    text = `${2018 + Number(era[1])}-${era[2]}-${era[3]}`;
    if (Number(era[1]) < 1 || (Number(era[1]) === 1 && Number(era[2]) < 5)) return raw;
  }
  return text;
}
