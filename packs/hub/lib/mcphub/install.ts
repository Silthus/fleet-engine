import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devboxGatewayUrl } from "./client.ts";
import { container, dataDir, must, ownedContainer, prepareMcpHub, requireHub, syncWhenReady, type Hub } from "./hub.ts";

export const mcphubImage = "samanhappy/mcphub@sha256:68228dabac98e22ce3d82e83b6f4f45d1b2b2c2d76342c61dc809b44329b2a58";
export const mcphubSource = {
  url: "https://codeload.github.com/samanhappy/mcphub/tar.gz/7d7df2599b0361b2b0238ff3f4e6c0f162da0943",
  sha256: "5543020667fdbc71e183dee6144a182318ff8f1368c0a479adacc7c1f010613e",
};
const sdkPackages = ["client", "core", "node", "server", "server-legacy"];
const compiledFiles = ["clients/legacyMcpClient.js", "services/mcpService.js"];

export async function install(hub: Hub) {
  if (hub.platform !== "linux") throw new Error("Install MCPHub on the Linux hub.");
  await requireHub(hub, "install");
  const baseUrl = devboxGatewayUrl(hub.gateway);
  const paths = await prepareMcpHub(hub.home, baseUrl, hub.gateway);
  const image = await buildImage(hub);
  let current = await ownedContainer(hub);
  const wanted = (JSON.parse(await must(hub, ["docker", "image", "inspect", image])) as Array<{ Id: string }>)[0]!.Id;
  const environment = (await readFile(paths.environment, "utf8")).split("\n").filter(Boolean);
  if (current && (current.Image !== wanted || !environment.every((line) => current!.Config.Env?.includes(line)))) {
    await must(hub, ["docker", "stop", container]);
    await must(hub, ["docker", "rm", container]);
    current = undefined;
  }
  const directory = dataDir(hub.home);
  if (!current) {
    await must(hub, ["docker", "run", "-d", "--name", container, "--label", "org.fleet.service=mcphub", "--restart", "unless-stopped",
      "--user", `${hub.uid}:${hub.gid}`, "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--env-file", paths.environment,
      "-p", "127.0.0.1:3317:3000", "-v", `${directory}/data:/app/data`, "-v", `${directory}/logs:/app/logs`, "--entrypoint", "node", image, "dist/index.js"]);
  } else if (!current.State.Running) await must(hub, ["docker", "start", container]);
  await syncWhenReady(hub);
  hub.print(`MCPHub installed: ${baseUrl}/`);
}

export async function buildImage(hub: Hub, source = mcphubSource) {
  const patchPath = join(hub.root, "mcphub/1.1.0-elicitation.patch");
  const sdkRoot = join(hub.root, "mcphub/sdk");
  const [patch, sdkManifest, sdkLock] = await Promise.all([readFile(patchPath), readFile(join(sdkRoot, "package.json")), readFile(join(sdkRoot, "pnpm-lock.yaml"))]);
  const image = `fleet-mcphub:1.1.0-${createHash("sha256").update(patch).update(sdkManifest).update(sdkLock).digest("hex").slice(0, 12)}`;
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
    const links = sdkPackages.map((name) => `ln -sfn /fleet-sdk/node_modules/@modelcontextprotocol/${name} /app/node_modules/@modelcontextprotocol/${name}`).join(" && ");
    await writeFile(join(build, "Dockerfile"), [
      `FROM ${mcphubImage}`,
      "COPY sdk/ /fleet-sdk/",
      `RUN cd /fleet-sdk && pnpm install --frozen-lockfile --prod --ignore-scripts && ${links}`,
      ...compiledFiles.map((file) => `COPY ${file} /app/dist/${file}`),
      'LABEL org.fleet.patch="1.1.0-elicitation"',
      "",
    ].join("\n"));
    await must(hub, ["docker", "build", "-t", image, build]);
    return image;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
