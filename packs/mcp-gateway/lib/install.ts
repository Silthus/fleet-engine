import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalUpstream } from "./apps.ts";
import { browserGatewayUrl } from "./client.ts";
import { declaredUpstreams } from "./declared.ts";
import { container, dataDir, must, ownedContainer, prepareMcpHub, syncWhenReady, type Hub } from "./hub.ts";

export const mcphubImage = "samanhappy/mcphub@sha256:68228dabac98e22ce3d82e83b6f4f45d1b2b2c2d76342c61dc809b44329b2a58";
export const mcphubSource = {
  url: "https://codeload.github.com/samanhappy/mcphub/tar.gz/7d7df2599b0361b2b0238ff3f4e6c0f162da0943",
  sha256: "5543020667fdbc71e183dee6144a182318ff8f1368c0a479adacc7c1f010613e",
};
export const codexMount = "/opt/fleet-codex";
export const bridgeFile = "/app/fleet-app-bridge.mjs";
export const legacyBridgeFile = "/app/fleet-slack-bridge.mjs";
export const codexPackage = (home: string) => join(home, ".local/share/fleet/codex");
export const localMount = "/fleet-local";
export const localDir = (home: string) => join(dataDir(home), "local");
export const localEntry = (upstream: Pick<LocalUpstream, "name">) => `${localMount}/${upstream.name}.mjs`;

type Mount = { Source?: string; Destination: string };
type Bundle = { path: string; bytes: Buffer };

const localUpstreams = async (home: string) => (await declaredUpstreams(home)).filter((upstream): upstream is LocalUpstream => upstream.kind === "local");

async function localBundles(home: string): Promise<Bundle[]> {
  const bundles: Bundle[] = [];
  for (const upstream of await localUpstreams(home)) {
    const build = await Bun.build({ entrypoints: [upstream.script], target: "node", format: "esm" }).catch((error: Error) => ({ success: false as const, logs: [error.message], outputs: [] }));
    if (!build.success) throw new Error(`${upstream.title} did not build from ${upstream.script}: ${build.logs.join("; ")}`);
    bundles.push({ path: join(localDir(home), `${upstream.name}.mjs`), bytes: Buffer.from(await build.outputs[0]!.arrayBuffer()) });
  }
  return bundles;
}

async function localMounts(home: string): Promise<Mount[]> {
  const upstreams = await localUpstreams(home);
  const mounts: Mount[] = upstreams.length ? [{ Source: localDir(home), Destination: localMount }] : [];
  for (const upstream of upstreams) {
    for (const mount of upstream.mounts ?? []) {
      const source = await realpath(mount.source).catch(() => { throw new Error(`${upstream.title} mounts ${mount.source}, which is missing on the hub.`); });
      mounts.push({ Source: source, Destination: mount.target });
    }
  }
  return mounts;
}

const mountKey = (mount: Mount) => `${mount.Source}:${mount.Destination}`;
const fleetMounts = (mounts: Mount[] = []) => mounts.filter((mount) => mount.Destination.startsWith("/fleet-")).map(mountKey).sort();
const mountsCurrent = (current: Mount[] | undefined, wanted: Mount[]) => Bun.deepEquals(fleetMounts(current), wanted.map(mountKey).sort());

async function bundlesCurrent(bundles: Bundle[]) {
  for (const bundle of bundles) if (!(await readFile(bundle.path).then((bytes) => bytes.equals(bundle.bytes), () => false))) return false;
  return true;
}

async function writeBundles(home: string, bundles: Bundle[]) {
  if (!bundles.length) return;
  await mkdir(localDir(home), { recursive: true, mode: 0o700 });
  for (const bundle of bundles) await writeFile(bundle.path, bundle.bytes, { mode: 0o600 });
}
const sdkPackages = ["client", "core", "node", "server", "server-legacy"];
const compiledFiles = ["clients/legacyMcpClient.js", "services/mcpService.js"];

export async function install(hub: Hub) {
  if (hub.platform !== "linux") throw new Error("Install MCPHub on the Linux hub.");
  const baseUrl = browserGatewayUrl(hub.gateway);
  const paths = await prepareMcpHub(hub.home, baseUrl, hub.gateway);
  const image = await buildImage(hub);
  let current = await ownedContainer(hub);
  const wanted = (JSON.parse(await must(hub, ["docker", "image", "inspect", image])) as Array<{ Id: string }>)[0]!.Id;
  const environment = (await readFile(paths.environment, "utf8")).split("\n").filter(Boolean);
  const mounted = current?.Mounts?.some((mount) => mount.Destination === codexMount);
  await writeBundles(hub.home, await localBundles(hub.home));
  const locals = await localMounts(hub.home);
  if (current && (current.Image !== wanted || !mounted || !mountsCurrent(current.Mounts, locals) || !environment.every((line) => current!.Config.Env?.includes(line)))) {
    await must(hub, ["docker", "stop", container]);
    await must(hub, ["docker", "rm", container]);
    current = undefined;
  }
  const directory = dataDir(hub.home);
  if (!current) {
    await mkdir(codexPackage(hub.home), { recursive: true });
    await must(hub, ["docker", "run", "-d", "--name", container, "--label", "org.fleet.service=mcphub", "--restart", "unless-stopped",
      "--user", `${hub.uid}:${hub.gid}`, "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--env-file", paths.environment,
      "-p", "127.0.0.1:3317:3000", "-v", `${directory}/data:/app/data`, "-v", `${directory}/logs:/app/logs`,
      "-v", `${codexPackage(hub.home)}:${codexMount}:ro`, ...locals.flatMap((mount) => ["-v", `${mount.Source}:${mount.Destination}:ro`]), "--entrypoint", "node", image, "dist/index.js"]);
  } else if (!current.State.Running) await must(hub, ["docker", "start", container]);
  await syncWhenReady(hub);
  hub.print(`MCPHub installed: ${baseUrl}/`);
}

export async function bridgeBundle(root: string) {
  const build = await Bun.build({ entrypoints: [join(root, "lib/app-bridge.ts")], target: "node", format: "esm" });
  if (!build.success) throw new Error(`The app bridge did not build: ${build.logs.join("; ")}`);
  return Buffer.from(await build.outputs[0]!.arrayBuffer());
}

async function imageParts(root: string) {
  const patchPath = join(root, "mcphub/1.1.0-elicitation.patch");
  const sdkRoot = join(root, "mcphub/sdk");
  const [patch, sdkManifest, sdkLock, bridge] = await Promise.all([readFile(patchPath), readFile(join(sdkRoot, "package.json")), readFile(join(sdkRoot, "pnpm-lock.yaml")), bridgeBundle(root)]);
  const image = `fleet-mcphub:1.1.0-${createHash("sha256").update(patch).update(sdkManifest).update(sdkLock).update(bridge).digest("hex").slice(0, 12)}`;
  return { patchPath, sdkManifest, sdkLock, bridge, image };
}

/** Whether the running gateway container is Fleet's, of the image this engine builds, with Fleet's Codex and each local upstream's current bundle and folders mounted. */
export async function gatewayCurrent(hub: Hub) {
  const { image } = await imageParts(hub.root);
  const built = await hub.run(["docker", "image", "inspect", image]);
  const running = await ownedContainer(hub).catch(() => undefined);
  if (built.code || !running?.State.Running) return false;
  if (running.Image !== (JSON.parse(built.stdout) as Array<{ Id: string }>)[0]!.Id || !running.Mounts?.some((mount) => mount.Destination === codexMount)) return false;
  const locals = await localMounts(hub.home).catch(() => undefined);
  return Boolean(locals && mountsCurrent(running.Mounts, locals) && (await bundlesCurrent(await localBundles(hub.home))));
}

export async function buildImage(hub: Hub, source = mcphubSource) {
  const { patchPath, sdkManifest, sdkLock, bridge, image } = await imageParts(hub.root);
  if ((await hub.run(["docker", "image", "inspect", image])).code === 0) return image;
  const response = await hub.fetch(source.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`MCPHub source download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== source.sha256) throw new Error("MCPHub source checksum mismatch");
  const work = await mkdtemp(join(tmpdir(), "fleet-mcphub-build-"));
  try {
    await writeFile(join(work, "source.tar.gz"), archive);
    await mkdir(join(work, "source"));
    await must(hub, ["tar", "xzf", join(work, "source.tar.gz"), "--strip-components=1", "-C", join(work, "source")]);
    await must(hub, ["git", "apply", patchPath], { cwd: join(work, "source") });
    await mkdir(join(work, "compiled"));
    await must(hub, ["docker", "run", "--rm", "--user", `${hub.uid}:${hub.gid}`, "--entrypoint", "node",
      "-v", `${work}/source/src:/app/src:ro`, "-v", `${work}/compiled:/fleet-output`, mcphubImage, "/app/node_modules/typescript/bin/tsc", "--outDir", "/fleet-output"]);
    const build = join(work, "build");
    for (const file of compiledFiles) await cp(join(work, "compiled", file), join(build, file), { recursive: true });
    await mkdir(join(build, "sdk"), { recursive: true });
    await writeFile(join(build, "sdk/package.json"), sdkManifest);
    await writeFile(join(build, "sdk/pnpm-lock.yaml"), sdkLock);
    await writeFile(join(build, "fleet-app-bridge.mjs"), bridge);
    const links = sdkPackages.map((name) => `ln -sfn /fleet-sdk/node_modules/@modelcontextprotocol/${name} /app/node_modules/@modelcontextprotocol/${name}`).join(" && ");
    await writeFile(join(build, "Dockerfile"), [
      `FROM ${mcphubImage}`,
      "COPY sdk/ /fleet-sdk/",
      `RUN cd /fleet-sdk && pnpm install --frozen-lockfile --prod --ignore-scripts && ${links}`,
      ...compiledFiles.map((file) => `COPY ${file} /app/dist/${file}`),
      `COPY fleet-app-bridge.mjs ${bridgeFile}`,
      `COPY fleet-app-bridge.mjs ${legacyBridgeFile}`,
      'LABEL org.fleet.patch="1.1.0-elicitation"',
      "",
    ].join("\n"));
    await must(hub, ["docker", "build", "-t", image, build]);
    return image;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
