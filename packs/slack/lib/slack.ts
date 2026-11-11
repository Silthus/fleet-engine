
export type Tokens = { appToken: string; userToken: string };
export type SlackApi = (method: string, args: Record<string, string | undefined>) => Promise<Record<string, any>>;
export type Sleep = (ms: number) => Promise<void>;

export const slackApiBase = "https://slack.com/api";

export function slackApp(saved: string | undefined): Tokens {
  if (saved === undefined) throw new Error("no Slack app is saved. Run fleet slack-trigger setup");
  const tokens = JSON.parse(saved) as Partial<Tokens>;
  if (!tokens.appToken?.startsWith("xapp-") || !tokens.userToken?.startsWith("xoxp-")) throw new Error("the saved Slack app needs appToken (xapp-…) and userToken (xoxp-…). Run fleet slack-trigger setup");
  return tokens as Tokens;
}

export function slackApi(token: string, base = slackApiBase, sleep: Sleep = Bun.sleep): SlackApi {
  return async (method, args) => {
    const body = new URLSearchParams(Object.entries(args).filter((entry): entry is [string, string] => entry[1] !== undefined));
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
      if (response.status === 429 && attempt < 3) {
        await sleep(Number(response.headers.get("retry-after") ?? 5) * 1000);
        continue;
      }
      const result = (await response.json()) as Record<string, any>;
      if (!result.ok) throw new Error(`${method}: ${result.error ?? response.status}`);
      return result;
    }
  };
}

export type ServeOptions = { appToken: string; onEvent: (event: Record<string, any>) => void; log: (line: string) => void; base?: string; sleep?: Sleep; stop?: AbortSignal };

export async function serve({ appToken, onEvent, log, base = slackApiBase, sleep = Bun.sleep, stop }: ServeOptions): Promise<void> {
  const open = slackApi(appToken, base, sleep);
  const stopped = new Promise<void>((resolve) => (stop?.aborted ? resolve() : stop?.addEventListener("abort", () => resolve(), { once: true })));
  const unlessStopped = <T>(work: Promise<T>) => Promise.race([work, stopped.then(() => undefined)]);
  for (let failures = 0; !stop?.aborted; ) {
    try {
      const opened = await unlessStopped(open("apps.connections.open", {}));
      if (!opened || stop?.aborted) return;
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(String(opened.url));
        const close = () => socket.close();
        stop?.addEventListener("abort", close, { once: true });
        socket.onmessage = (message) => {
          const envelope = JSON.parse(String(message.data)) as Record<string, any>;
          if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          if (envelope.type === "hello") {
            failures = 0;
            log("connected");
          }
          if (envelope.type === "disconnect") socket.close();
          if (envelope.type === "events_api" && envelope.payload?.event) onEvent(envelope.payload.event);
        };
        socket.onclose = () => {
          stop?.removeEventListener("abort", close);
          resolve();
        };
        socket.onerror = () => socket.close();
      });
    } catch (error) {
      log(`connection failed: ${error}`);
    }
    if (stop?.aborted) return;
    failures++;
    await unlessStopped(sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
  }
}

export function manifest(name: string) {
  const app = `T3Code - ${name}`.slice(0, 35);
  return {
    display_information: { name: app, description: `Starts a T3 Code thread on ${name}'s machines from its trigger emoji in Slack.` },
    features: { bot_user: { display_name: app, always_online: true } },
    oauth_config: {
      scopes: {
        bot: ["app_mentions:read"],
        user: ["channels:history", "groups:history", "im:history", "mpim:history", "reactions:read", "reactions:write", "chat:write", "users:read"],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ["app_mention"], user_events: ["message.channels", "message.groups", "message.im", "message.mpim", "reaction_added"] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export const manifestLink = (name: string) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(name)))}`;
