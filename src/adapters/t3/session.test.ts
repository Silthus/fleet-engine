import { afterEach, expect, test } from "bun:test";
import { connect } from "./session.ts";

const real = globalThis.WebSocket;
afterEach(() => void (globalThis.WebSocket = real));

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
