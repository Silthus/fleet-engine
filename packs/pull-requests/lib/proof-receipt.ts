export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const block = /<!-- fleet-proof-receipt\b[^>]*-->[\s\S]*?<!-- \/fleet-proof-receipt -->/g;

export const withoutReceipt = (body: string) => body.replace(block, "");
