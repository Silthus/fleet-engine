export type Tone = "blue" | "red" | "yellow" | "sky" | "peach" | "lilac" | "mint" | "cream";

export type Art = { file: string; alt: string };

export type Role = { art: Art; tone: Tone; line: string };

const hog = (name: string, alt = ""): Art => ({ file: `${name}.png`, alt });

export const packCast: Record<string, Role> = {
  base: { art: hog("list-hog"), tone: "cream", line: "Every machine gets safety rules and tuned defaults." },
  "pull-requests": { art: hog("builder-hog-03"), tone: "yellow", line: "Every fix ends as a reviewed draft pull request." },
  orchestration: { art: hog("professor-hog"), tone: "sky", line: "A conductor thread splits big work into tickets." },
  communication: { art: hog("microphone-hog"), tone: "peach", line: "Agents write in your voice and share plans as links." },
  integrations: { art: hog("desk-hog"), tone: "blue", line: "Agents reach GitHub, current docs, and Convex." },
  memory: { art: hog("reading-hog"), tone: "mint", line: "Agents on every machine share what they learn." },
  "context-library": { art: hog("detective-hog"), tone: "lilac", line: "Agents find your plans and decisions in your notes." },
  guards: { art: hog("police-hog"), tone: "lilac", line: "Hooks stop an agent's risky shell commands." },
  slack: { art: hog("phone-pair-hogs"), tone: "cream", line: "Your own Slack message starts a thread." },
  "incident-io": { art: hog("warning-hog"), tone: "red", line: "An agent pages you when a risky change goes wrong." },
  hub: { art: hog("space-hog"), tone: "sky", line: "One always-on devbox links and watches the others." },
  "mcp-gateway": { art: hog("hog-welder"), tone: "mint", line: "Sign in to your MCP servers once, on the hub." },
  recovery: { art: hog("hospital-hog"), tone: "peach", line: "Threads continue after a usage limit or an outage." },
};

export const teamRole = (line: string): Role => ({ art: hog("heart-hog"), tone: "yellow", line });

export const crew: Array<{ pack: string; says: string }> = [
  { pack: "orchestration", says: "4 threads running" },
  { pack: "pull-requests", says: "Draft PR is up" },
  { pack: "communication", says: "Update posted" },
];

export const scenes = {
  crew: "Three hedgehogs at work: a professor, a builder, and a reporter.",
  problems: [
    { art: hog("burning-money-hog"), tone: "peach" as Tone, title: "Every machine needs its own setup", line: "You add rules, skills, hooks, and sign-ins by hand." },
    { art: hog("surprised-hog"), tone: "sky" as Tone, title: "Your machines stop matching", line: "Your laptop knows a rule that your devbox does not." },
    { art: hog("sleeping-hog"), tone: "lilac" as Tone, title: "Agents stop when your Mac sleeps", line: "Work overnight needs a machine that stays on." },
  ],
  fleet: hog("robot-hog"),
  mac: hog("laptop-hog-02"),
  hub: hog("space-hog"),
  packs: hog("explorer-hog"),
  empty: hog("detective-hog"),
};

export const logos = { light: "posthog-logo-light.svg", dark: "posthog-logo-dark.svg" };

export const artFiles = () => [
  ...new Set([
    ...Object.values(packCast).map((role) => role.art.file),
    teamRole("").art.file,
    ...scenes.problems.map((problem) => problem.art.file),
    ...[scenes.fleet, scenes.mac, scenes.hub, scenes.packs, scenes.empty].map((art) => art.file),
    logos.light,
    logos.dark,
  ]),
];
