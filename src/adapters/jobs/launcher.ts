export const jobsFolder = ".local/state/fleet/jobs";

export const launcherTarget = (id: string) => `${jobsFolder}/${id}.sh`;
export const logTarget = (id: string) => `${jobsFolder}/${id}.log`;

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A shell script that runs one job with Fleet's PATH and appends its output to the job's log. */
export function launcherScript(command: string[], path: string, log: string) {
  return ["#!/bin/sh", `PATH=${quote(path)}`, "export PATH", `exec ${command.map(quote).join(" ")} >>${quote(log)} 2>&1`, ""].join("\n");
}
