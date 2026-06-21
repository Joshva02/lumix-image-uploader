import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig } from "../config.ts";
import type { CameraState, LumixClient } from "../lumix/client.ts";
import { CamCgiError } from "../lumix/camCgi.ts";

/**
 * The agent's web surface for phase 1.
 *
 * Crucially the browser talks ONLY to this agent over plain `http://localhost`,
 * never to the camera. That's what avoids the browser's mixed-content and CORS
 * walls — the agent does all the camera I/O and pushes results to the page.
 *
 * Endpoints:
 *   GET  /                front-end page
 *   GET  /api/status      JSON snapshot (target, connected, last state)
 *   GET  /api/events      Server-Sent Events stream of live updates
 *   POST /api/connect     handshake + start keep-alive
 *   POST /api/disconnect  stop keep-alive + release the camera
 *
 * Live push uses SSE (built into the browser via EventSource, zero deps). Phase
 * 4 can upgrade this to a WebSocket when bidirectional/binary progress is needed.
 */

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

interface SseEvent {
  type: "connected" | "state" | "disconnected" | "keepalive-error" | "info" | "error";
  time: string;
  message?: string;
  state?: CameraState;
}

export interface AgentServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export function startServer(client: LumixClient, config: AgentConfig): Promise<AgentServer> {
  const sseClients = new Set<http.ServerResponse>();
  let lastState: CameraState | undefined;

  const now = (): string => new Date().toISOString();

  const broadcast = (event: SseEvent): void => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };

  // Mirror the client's lifecycle onto the SSE stream and the status snapshot.
  client.on("connected", ({ name, guid }) => {
    broadcast({ type: "connected", time: now(), message: `registered as "${name}" (${guid})` });
  });
  client.on("state", (state) => {
    lastState = state;
    broadcast({ type: "state", time: now(), state });
  });
  client.on("keepalive-error", (err) => {
    broadcast({ type: "keepalive-error", time: now(), message: err.message });
  });
  client.on("disconnected", () => {
    lastState = undefined;
    broadcast({ type: "disconnected", time: now() });
  });

  const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(text);
  };

  const handleStatus = (res: http.ServerResponse): void => {
    sendJson(res, 200, {
      target: client.target,
      connected: client.isConnected,
      controller: {
        name: config.controllerName,
        guid: config.controllerGuid,
      },
      keepAliveIntervalMs: config.keepAliveIntervalMs,
      lastState: lastState ?? null,
    });
  };

  const handleEvents = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Prime the stream so EventSource fires `open` immediately.
    res.write(`retry: 3000\n\n`);
    sseClients.add(res);
    // Send a snapshot so a freshly-opened page reflects current reality.
    const snapshot: SseEvent = client.isConnected
      ? { type: "connected", time: now(), message: "already connected" }
      : { type: "info", time: now(), message: "agent ready — not connected" };
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    if (lastState) res.write(`data: ${JSON.stringify({ type: "state", time: now(), state: lastState })}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
    });
  };

  const handleConnect = async (res: http.ServerResponse): Promise<void> => {
    if (client.isConnected) {
      sendJson(res, 200, { ok: true, connected: true, message: "already connected" });
      return;
    }
    try {
      await client.connect();
      client.startKeepAlive();
      sendJson(res, 200, { ok: true, connected: true });
    } catch (err) {
      const message = err instanceof CamCgiError ? err.message : (err as Error).message;
      broadcast({ type: "error", time: now(), message: `connect failed: ${message}` });
      sendJson(res, 502, {
        ok: false,
        connected: false,
        error: message,
        hint: "camera Wi-Fi on? correct host? camera not locked by the Lumix Sync app?",
      });
    }
  };

  const handleDisconnect = async (res: http.ServerResponse): Promise<void> => {
    await client.disconnect();
    sendJson(res, 200, { ok: true, connected: false });
  };

  const handleStatic = async (res: http.ServerResponse): Promise<void> => {
    try {
      const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Front-end not found. Expected public/index.html");
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    void (async () => {
      try {
        switch (route) {
          case "GET /":
          case "GET /index.html":
            return await handleStatic(res);
          case "GET /api/status":
            return handleStatus(res);
          case "GET /api/events":
            return handleEvents(req, res);
          case "POST /api/connect":
            return await handleConnect(res);
          case "POST /api/disconnect":
            return await handleDisconnect(res);
          case "GET /favicon.ico":
            res.writeHead(204);
            return res.end();
          default:
            sendJson(res, 404, { error: `no route for ${route}` });
        }
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });

  return new Promise<AgentServer>((resolve) => {
    // Bind to localhost only — this is a local agent, not a network service.
    server.listen(config.webPort, "127.0.0.1", () => {
      const url = `http://localhost:${config.webPort}`;
      resolve({
        server,
        url,
        close: () =>
          new Promise<void>((done) => {
            for (const res of sseClients) res.end();
            sseClients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
