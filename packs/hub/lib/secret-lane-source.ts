import { fleetOnHub, HubUnreachable, remoteHub, runSsh, type Env, type Ssh } from "./hub-transport.ts";
import { laneReport, olderHub, SecretRefusal, type LaneReport } from "./secret-store.ts";

type LaneReply = ({ ok: true } & Partial<LaneReport>) | { ok: false; error: string };

export async function laneSecretLines({ home, env, ssh }: { home: string; env: Env; ssh?: Ssh }, lane: string): Promise<LaneReport> {
  const hub = remoteHub(home, env);
  if (!hub) return laneReport(home, lane);
  const result = await (ssh ?? runSsh)(hub, fleetOnHub(hub, ["secret", "hub"]), JSON.stringify({ op: "lane", lane }));
  if (result.code !== 0) throw new HubUnreachable(`the hub ${hub} did not send the lane's secret lines (exit ${result.code}). Its output is not shown; check it with ssh ${hub} fleet secret list`);
  let reply: LaneReply;
  try { reply = JSON.parse(result.stdout) as LaneReply; }
  catch { throw new HubUnreachable(`the hub ${hub} sent no answer the store understands; run fleet update there`); }
  if (!reply.ok) throw new SecretRefusal(`The secret store refused the lane's lines: ${reply.error}`);
  if (!Array.isArray(reply.revokes) || !Array.isArray(reply.late)) throw new SecretRefusal(`The secret store sent no lane lines: ${olderHub("lane read")}`);
  return { revokes: reply.revokes, late: reply.late };
}
