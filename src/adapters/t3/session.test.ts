import { afterEach, expect, test } from "bun:test";
import { startT3Stub, type T3Stub } from "../../integrations/t3/testing.ts";
import { connect, localT3Server } from "./session.ts";

const real = globalThis.WebSocket;
let stub: T3Stub | undefined;
afterEach(async () => {
  globalThis.WebSocket = real;
  await stub?.stop();
  stub = undefined;
});

test("closes the socket when the handshake fails", async () => {
  const sockets: Array<{ closed: number }> = [];
  class FailingSocket {
    closed = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onerror?.());
    }
    close() {
      this.closed++;
    }
  }
  globalThis.WebSocket = FailingSocket as unknown as typeof WebSocket;
  expect(connect("http://127.0.0.1:1", "token")).rejects.toThrow("T3 Code did not answer at http://127.0.0.1:1");
  await Promise.resolve();
  expect(sockets.map((socket) => socket.closed)).toEqual([1]);
});

test.if(process.platform === "linux")("works inside a session that the running T3 server issues, and revokes the session before it returns", async () => {
  const shell = { projects: [], threads: [] };
  stub = await startT3Stub({ shell });
  const answer = await localT3Server.session(stub.home, (rpc) => rpc.get("/api/orchestration/shell"));
  expect(answer).toEqual(shell);
  expect(await stub.cliCalls()).toEqual(["auth session issue --json --ttl 5m --label fleet --subject fleet", "auth session revoke shell-session"]);
});
