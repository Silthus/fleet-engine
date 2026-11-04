import { descendants, fetchIssueFromGitHub, mapRef, parked, ticketType, type Blocker, type FetchIssue, type MapIo, type MapRef, type Ticket } from "./wayfinder.ts";

const usage = "Usage: fleet frontier <map URL | owner/repo#number | number>";

export async function readFrontier(ref: MapRef, fetchIssue: FetchIssue): Promise<string> {
  const map = await fetchIssue(ref.owner, ref.repo, ref.number);
  const tickets = await descendants(map, fetchIssue);
  const open = tickets.filter((ticket) => ticket.state === "OPEN");
  const isParked = (ticket: Ticket) => ticket.labels.includes(parked);
  const claimed = open.filter((ticket) => ticket.assignees.length && !isParked(ticket));
  const unclaimed = open.filter((ticket) => !ticket.assignees.length && !isParked(ticket));
  const sections: [string, Ticket[]][] = [
    ["Frontier, open, unblocked, and unclaimed, in map order:", unclaimed.filter((ticket) => !openBlockers(ticket).length)],
    ["Claimed:", claimed],
    ["Parked, awaiting the human:", open.filter(isParked)],
    ["Blocked:", unclaimed.filter((ticket) => openBlockers(ticket).length)],
  ];
  const closed = tickets.filter((ticket) => ticket.state !== "OPEN");
  return [
    `Map ${ref.owner}/${ref.repo}#${ref.number}: ${map.title} (${open.length} open, ${closed.length} closed)\n`,
    ...sections.flatMap(([heading, list], index) => list.length || index === 0
      ? [heading, ...(list.length ? list.map((ticket) => `  ${line(ticket, map.repository)}`) : ["  none"])] : []),
    ...(closed.length ? [`Closed: ${closed.map((ticket) => `#${ticket.number}`).join(" ")}`] : []),
  ].join("\n");
}

function openBlockers(ticket: Ticket): Blocker[] {
  return ticket.blockedBy.filter((blocker) => blocker.state === "OPEN");
}

function line(ticket: Ticket, mapRepository: string): string {
  const name = (blocker: Blocker) => blocker.repository === mapRepository ? `#${blocker.number}` : `${blocker.repository}#${blocker.number}`;
  const notes = [
    ticket.parent ? `under #${ticket.parent}` : "",
    openBlockers(ticket).length ? `blocked by ${openBlockers(ticket).map(name).join(", ")}` : "",
  ].filter(Boolean);
  const head = [`#${ticket.number}`, ticketType(ticket), ...ticket.assignees.map((login) => `@${login}`)].filter(Boolean).join(" ");
  return `${head}: ${ticket.title}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

export async function runFrontier(args: string[], io: MapIo): Promise<number> {
  if (args.length !== 1) throw new Error(usage);
  io.print(await readFrontier(mapRef(args[0]!, usage, io.tracker), io.fetchIssue ?? fetchIssueFromGitHub));
  return 0;
}
