import { riskCalloutOf } from "./decision-ledger.ts";

export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const blockText = String.raw`${escaped(receiptOpen)}\b[^>]*-->(?:(?!${escaped(receiptOpen)})[\s\S])*?${escaped(receiptClose)}`;
const blockAndBreak = new RegExp(String.raw`${blockText}(?:\r?\n){0,2}`, "g");

export function withoutReceipt(body: string) {
  const stripped = body.replace(blockAndBreak, "");
  return riskCalloutOf(stripped) === riskCalloutOf(body) ? stripped : body;
}
