import { riskCallout } from "./decision-ledger.ts";

export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const blockText = String.raw`${escaped(receiptOpen)}\b[^>]*-->(?:(?!${escaped(receiptOpen)})[\s\S])*?${escaped(receiptClose)}`;
const blockAndBreak = new RegExp(String.raw`${blockText}(?:\r?\n){0,2}`, "g");
const stripped = (text: string) => text.replace(blockAndBreak, "");

export function withoutReceipt(body: string) {
  const callout = riskCallout.exec(body);
  if (!callout) return stripped(body);
  const end = callout.index + callout[0].length;
  return stripped(body.slice(0, callout.index)) + callout[0] + stripped(body.slice(end));
}
