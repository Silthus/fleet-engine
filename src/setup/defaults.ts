import type { SourceRef } from "../pack/types.ts";

export const engineRepo = "Silthus/fleet-engine";

export const defaultSources: SourceRef[] = [
  { name: "agent-skills", repo: "Silthus/agent-skills", ref: "997eb88e03cb322941f387ab577207335d77c414" },
  { name: "mattpocock-skills", repo: "mattpocock/skills", ref: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" },
];
