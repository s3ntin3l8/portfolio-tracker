import { toDateKey } from "@portfolio/core";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import {
  parseGerman,
  addMoney,
  parseTrDate,
  pushDraft,
  extractBuchung,
  type TrPdfResult,
} from "./helpers.js";

export function parseTrInterest(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const account = text.match(/VERRECHNUNGSKONTO\s+(\d+)/)?.[1] ?? null;
  const headerDate = parseTrDate(text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]);

  const kapst = parseGerman(text.match(/Kapitalertrags?steuer\s+([\d.,]+)\s+EUR/)?.[1]);
  const solz = parseGerman(text.match(/Solidaritätszuschlag\s+([\d.,]+)\s+EUR/)?.[1]);
  const kapstNum = kapst ? Number(kapst) : 0;
  const solzNum = solz ? Number(solz) : 0;
  const taxNum = kapstNum + solzNum;
  const tax = taxNum > 0 ? taxNum.toFixed(2) : undefined;
  const taxComponents: TaxComponents = {};
  if (kapstNum > 0) taxComponents.kapitalertragsteuer = kapst!;
  if (solzNum > 0) taxComponents.solidaritaetszuschlag = solz!;

  const buchung = extractBuchung(text);
  const payDate = buchung.date ?? headerDate;
  const net = parseGerman(buchung.amountRaw?.replace(/^-/, ""));
  const besteuerung = parseGerman(text.match(/Besteuerungsgrundlage\s+([\d.,]+)\s+EUR/)?.[1]);
  const total = besteuerung ?? (net && tax ? addMoney(net, tax) : (net ?? undefined));

  const payDateStr = payDate ? toDateKey(payDate) : undefined;
  const externalId = account && payDateStr ? `tr:int:${account}:${payDateStr}` : undefined;

  pushDraft(
    {
      action: "interest",
      name: "Zinsen",
      quantity: "0",
      price: net ?? "",
      total: total ?? undefined,
      tax: tax ?? undefined,
      taxComponents: Object.keys(taxComponents).length > 0 ? taxComponents : undefined,
      currency: "EUR",
      executedAt: payDate ?? undefined,
      externalId,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber: account };
}
