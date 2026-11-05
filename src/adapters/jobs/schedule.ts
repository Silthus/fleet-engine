import type { Owned, PackJob, TimerSchedule as Schedule } from "../../pack/types.ts";

export type TimedJob = Owned<PackJob> & { schedule: Schedule };

export const isService = (job: Owned<PackJob>) => job.schedule.every === "always";
export const isTimed = (job: Owned<PackJob>): job is TimedJob => !isService(job);

export const defaultTime = "03:17";

const minutes = { "5m": 5, "15m": 15, "1h": 60 } as const;

function clock(schedule: Schedule) {
  const [hour, minute] = (schedule.at ?? defaultTime).split(":").map(Number) as [number, number];
  return { hour, minute };
}

export function cronExpression(schedule: Schedule) {
  const { hour, minute } = clock(schedule);
  if (schedule.every === "1d") return `${minute} ${hour} * * *`;
  if (schedule.every === "1h") return `${minute} * * * *`;
  return `*/${minutes[schedule.every]} * * * *`;
}

export type LaunchdTimer = { StartInterval: number } | { StartCalendarInterval: { Hour?: number; Minute: number } };

export function launchdTimer(schedule: Schedule): LaunchdTimer {
  const { hour, minute } = clock(schedule);
  if (schedule.every === "1d") return { StartCalendarInterval: { Hour: hour, Minute: minute } };
  if (schedule.every === "1h") return { StartCalendarInterval: { Minute: minute } };
  return { StartInterval: minutes[schedule.every] * 60 };
}

export type T3Schedule = { type: "interval"; everyMs: number } | { type: "fixed_time"; timeOfDay: string };

export function t3Schedule(schedule: Schedule): T3Schedule {
  if (schedule.every === "1d") return { type: "fixed_time", timeOfDay: schedule.at ?? defaultTime };
  return { type: "interval", everyMs: minutes[schedule.every] * 60_000 };
}
