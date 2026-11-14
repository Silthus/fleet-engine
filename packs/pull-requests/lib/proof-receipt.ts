export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const blockText = String.raw`<!-- fleet-proof-receipt\b[^>]*-->(?:(?!<!-- fleet-proof-receipt)[\s\S])*?<!-- \/fleet-proof-receipt -->`;
const blockAndBreak = new RegExp(String.raw`${blockText}(?:\r?\n){0,2}`, "g");

export const withoutReceipt = (body: string) => body.replace(blockAndBreak, "");
