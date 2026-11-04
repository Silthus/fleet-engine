import { secretKinds } from "../../base/hooks/secret-guard.ts";

const kinds = secretKinds(await Bun.stdin.text());
if (kinds.length) console.error(`Secret scan: found ${kinds.join(", ")}`);
process.exit(kinds.length ? 1 : 0);
