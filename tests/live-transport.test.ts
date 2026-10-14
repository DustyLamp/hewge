import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchAuction } from "../src/live-auction";

class Socket {
  static all: Socket[] = [];
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    Socket.all.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  message(value: any) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { hidden: false }),
  );
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const ticket = async () => ({
  token: "studio:test",
  channel: "/rehearsal/test",
  http: "example.appsync-api.eu-north-1.amazonaws.com",
  realtime: "example.appsync-realtime-api.eu-north-1.amazonaws.com",
  expiresAt: 1,
});

describe("auction socket recovery", () => {
  it("authenticates, subscribes and resynchronises after acknowledgement", async () => {
    const changed = vi.fn(),
      status = vi.fn();
    stop = watchAuction(ticket, changed, status);
    await vi.advanceTimersByTimeAsync(0);
    const ws = Socket.all[0];
    expect(ws.url).toContain("/event/realtime");
    expect(ws.protocols[0]).toBe("aws-appsync-event-ws");
    ws.onopen?.();
    expect(ws.sent[0]).toEqual({ type: "connection_init" });
    ws.message({ type: "connection_ack", connectionTimeoutMs: 300000 });
    expect(ws.sent[1]).toMatchObject({
      type: "subscribe",
      channel: "/rehearsal/test",
      authorization: { Authorization: "studio:test" },
    });
    ws.message({ type: "subscribe_success" });
    expect(changed).toHaveBeenCalledWith();
    expect(status).toHaveBeenLastCalledWith("live");
    ws.message({
      type: "data",
      event: ['{"revision":7}', '{"revision":"bad"}'],
    });
    expect(changed).toHaveBeenLastCalledWith(7);
    expect(changed).toHaveBeenCalledTimes(2);
    ws.message({ type: "data", event: '{"revision":8}' });
    expect(changed).toHaveBeenLastCalledWith(8);
    ws.message({ type: "data", event: { revision: 9 } });
    expect(changed).toHaveBeenLastCalledWith(9);
  });
  it("falls back and reconnects with jitter when the connection fails", async () => {
    const status = vi.fn();
    stop = watchAuction(ticket, vi.fn(), status);
    await vi.advanceTimersByTimeAsync(0);
    Socket.all[0].onerror?.();
    expect(Socket.all[0].closed).toBe(true);
    expect(status).toHaveBeenLastCalledWith("polling");
    await vi.advanceTimersByTimeAsync(1400);
    expect(Socket.all).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.all).toHaveLength(2);
  });
  it("closes hidden tabs, resynchronises when visible and renews without trusting the phone clock", async () => {
    const changed = vi.fn();
    stop = watchAuction(ticket, changed, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(Socket.all[0].closed).toBe(true);
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.all).toHaveLength(2);
    const ws = Socket.all[1];
    ws.message({ type: "connection_ack", connectionTimeoutMs: 300000 });
    ws.message({ type: "subscribe_success" });
    await vi.advanceTimersByTimeAsync(230000);
    expect(Socket.all).toHaveLength(3);
    expect(ws.closed).toBe(true);
    expect(changed).toHaveBeenCalled();
  });
});
