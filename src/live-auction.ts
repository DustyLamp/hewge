import { useEffect, useRef, useState } from "react";
import { api, getToken } from "./api";
import type { Release } from "../shared/auction";

type Ticket = {
  token: string;
  channel: string;
  http: string;
  realtime: string;
  expiresAt: number;
};
export type Connection = "connecting" | "live" | "polling" | "paused";
export function watchAuction(
  ticket: () => Promise<Ticket>,
  changed: (revision?: number) => void,
  status: (value: Connection) => void,
) {
  let stopped = false,
    socket: WebSocket | undefined,
    attempts = 0,
    generation = 0;
  let reconnect: ReturnType<typeof setTimeout>,
    heartbeat: ReturnType<typeof setTimeout>,
    renewal: ReturnType<typeof setTimeout>;
  const stopSocket = () => {
    generation++;
    clearTimeout(heartbeat);
    clearTimeout(renewal);
    clearTimeout(reconnect);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = undefined;
    }
  };
  async function connect() {
    if (stopped || document.hidden || !navigator.onLine) {
      status("paused");
      return;
    }
    stopSocket();
    const gen = generation;
    status(attempts ? "polling" : "connecting");
    const retry = () => {
      if (stopped || gen !== generation) return;
      stopSocket();
      status("polling");
      reconnect = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) *
          (0.7 + Math.random() * 0.6),
      );
    };
    try {
      const t = await ticket();
      if (stopped || gen !== generation) return;
      if (!t.http || !t.realtime) throw Error("Live updates unavailable");
      const authorization = { host: t.http, Authorization: t.token };
      const encoded = btoa(JSON.stringify(authorization))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const ws = new WebSocket(`wss://${t.realtime}/event/realtime`, [
        "aws-appsync-event-ws",
        `header-${encoded}`,
      ]);
      socket = ws;
      const arm = (ms: number) => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(retry, ms);
      };
      arm(15000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
      ws.onerror = retry;
      ws.onclose = retry;
      let timeout = 300000;
      ws.onmessage = (event) => {
        if (stopped || gen !== generation) return;
        try {
          const m = JSON.parse(event.data);
          if (m.type === "connection_ack") {
            timeout = Math.min(Number(m.connectionTimeoutMs) || 300000, 300000);
            arm(timeout);
            ws.send(
              JSON.stringify({
                type: "subscribe",
                id: "auction",
                channel: t.channel,
                authorization,
              }),
            );
          } else if (m.type === "ka") arm(timeout);
          else if (m.type === "subscribe_success") {
            attempts = 0;
            status("live");
            changed(); // Close the snapshot/subscribe race.
          } else if (m.type === "data") {
            for (const raw of Array.isArray(m.event) ? m.event : [m.event]) {
              const value = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (value && Number.isSafeInteger(value.revision))
                changed(value.revision);
            }
          } else if (String(m.type).endsWith("error")) retry();
        } catch {
          retry();
        }
      };
      renewal = setTimeout(connect, Math.max(1000, 230000));
    } catch {
      retry();
    }
  }
  const wake = () => {
    stopSocket();
    if (!document.hidden && navigator.onLine) {
      attempts = 0;
      changed();
      void connect();
    } else status("paused");
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  void connect();
  return () => {
    stopped = true;
    stopSocket();
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("offline", wake);
  };
}

export function useLiveAuction(id?: string, simulation = false) {
  const [release, setRelease] = useState<Release>();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState(false);
  const [personal, setPersonal] = useState<{
    leading: boolean;
    hasBid: boolean;
    revision: number;
  }>();
  const [enabled, setEnabled] = useState(false);
  const [leader, setLeader] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    setRelease(undefined);
    setPersonal(undefined);
    setFresh(false);
    setError("");
    if (!id) return;
    let alive = true,
      currentRevision = -1,
      requestedRevision = -1,
      lastRead = -Infinity;
    let inFlight: Promise<void> | null = null,
      needsRefresh = false;
    let boundary: ReturnType<typeof setTimeout>;
    let debounce: ReturnType<typeof setTimeout>,
      poll: ReturnType<typeof setTimeout>;
    let mode: Connection = "connecting",
      failures = 0;
    async function refresh(): Promise<void> {
      if (!alive) return;
      if (inFlight) {
        needsRefresh = true;
        return inFlight;
      }
      inFlight = (async () => {
        try {
          const data = await api(
            simulation ? `/admin/rehearsal/${id}` : `/auction/${id}`,
          );
          if (!alive) return;
          const rev = data.release.revision || 0;
          if (rev >= currentRevision) {
            currentRevision = rev;
            lastRead = performance.now();
            failures = 0;
            clearTimeout(boundary);
            const target =
              data.release.status === "scheduled"
                ? data.release.opensAt
                : data.release.status === "open"
                  ? data.release.closesAt
                  : null;
            if (target)
              boundary = setTimeout(
                () => void refresh(),
                Math.min(
                  2147483647,
                  Math.max(100, target - data.release.serverNow + 100),
                ),
              );
            setRelease(data.release);
            setEnabled(simulation || data.biddingEnabled === true);
            setError("");
            setFresh(true);
            if (simulation) {
              setLeader(data.leader);
              setPersonal({
                revision: rev,
                leading: data.leader === "you",
                hasBid: data.release.recentBids?.length > 0,
              });
            } else if (getToken()) {
              try {
                const p = await api(`/bid/state/${id}`);
                if (alive) setPersonal(p);
              } catch {
                if (alive) setPersonal(undefined);
              }
            }
          }
        } catch (e) {
          failures++;
          if (alive) {
            setError((e as Error).message);
            setFresh(false);
          }
        }
      })();
      await inFlight;
      inFlight = null;
      if (
        alive &&
        (needsRefresh || (requestedRevision > currentRevision && !failures))
      ) {
        needsRefresh = false;
        clearTimeout(debounce);
        debounce = setTimeout(() => void refresh(), 500 + Math.random() * 500);
      }
    }
    refreshRef.current = refresh;
    const changed = (revision?: number) => {
      if (revision !== undefined && revision <= currentRevision) return;
      requestedRevision = Math.max(requestedRevision, revision || 0);
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), 150 + Math.random() * 350);
    };
    const stop = watchAuction(
      () =>
        simulation
          ? api("/admin/rehearsal/ticket", { id })
          : api(`/live/${id}`),
      changed,
      (value) => {
        mode = value;
        if (alive) setConnection(value);
      },
    );
    void refresh();
    const polling = () => {
      if (!alive) return;
      if (!document.hidden && navigator.onLine) void refresh();
      poll = setTimeout(
        polling,
        (mode === "live"
          ? 20000
          : Math.min(30000, 5000 * 2 ** Math.min(failures, 3))) *
          (0.8 + Math.random() * 0.4),
      );
    };
    poll = setTimeout(polling, 5000);
    const freshness = setInterval(() => {
      if (alive)
        setFresh(
          failures === 0 &&
            navigator.onLine &&
            performance.now() - lastRead < 30000,
        );
    }, 1000);
    return () => {
      alive = false;
      stop();
      clearTimeout(boundary);
      clearTimeout(debounce);
      clearTimeout(poll);
      clearInterval(freshness);
      refreshRef.current = async () => {};
    };
  }, [id, simulation]);
  return {
    release,
    enabled,
    connection,
    error,
    fresh,
    personal,
    leader,
    refresh: () => refreshRef.current(),
  };
}
