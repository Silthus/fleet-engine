import { memoryTemp } from "./memory-temp.ts";

memoryTemp(process.env, { memory: "/dev/shm", pid: process.pid });
