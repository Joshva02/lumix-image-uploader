import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { AgentConfig } from "../config.ts";
import type { CameraState, LumixClient } from "../lumix/client.ts";
import { CamCgiError } from "../lumix/camCgi.ts";
import { PhotoCatalog } from "../lumix/catalog.ts";
import type { Photo } from "../lumix/contentDirectory.ts";

/**
 * The agent's web surface.
 *
 * Crucially the browser talks ONLY to this agent over plain `http://localhost`,
 * never to the camera. That's what avoids the browser's mixed-content and CORS
 * walls — the agent does all the camera I/O and pushes results to the page.
 * Photo thumbnails and files are proxied through the agent for the same reason.
 *
 * Endpoints:
 *   GET  /                       front-end page
 *   GET  /api/status             JSON snapshot (target, connected, last state)
 *   GET  /api/events             Server-Sent Events stream of live updates
 *   POST /api/connect            handshake + start keep-alive
 *   POST /api/disconnect         stop keep-alive + release the camera
 *   GET  /api/photos             browse the card; list photos (?refresh=1)
 *   GET  /api/photos/:id/thumb   proxied thumbnail bytes
 *   GET  /api/photos/:id/file    proxied full file (?kind=jpeg|raw)
 *
 * Live push uses SSE (built into the browser via EventSource, zero deps). Phase
 * 4 can upgrade this to a WebSocket when bidirectional/binary progress is needed.
 */

const PHOTO_THUMB_RE = /^\/api\/photos\/([^/]+)\/thumb$/;
const PHOTO_FILE_RE = /^\/api\/photos\/([^/]+)\/file$/;

/** Shape sent to the front end — camera URLs stay server-side; the browser only
 *  ever sees agent-proxied paths. */
function toSummary(p: Photo): Record<string, unknown> {
  const id = encodeURIComponent(p.id);
  return {
    id: p.id,
    title: p.title,
    date: p.date ?? null,
    hasJpeg: Boolean(p.jpegUrl),
    hasRaw: Boolean(p.rawUrl),
    thumb: p.thumbnailUrl ? `/api/photos/${id}/thumb` : null,
    jpeg: p.jpegUrl ? `/api/photos/${id}/file?kind=jpeg` : null,
    raw: p.rawUrl ? `/api/photos/${id}/file?kind=raw` : null,
  };
}

const PUBLIC_DIR = path.resolve(import.meta.dirname, "../../public");

interface SseEvent {
  type: "connected" | "state" | "disconnected" | "keepalive-error" | "info" | "error" | "photos";
  time: string;
  message?: string;
  state?: CameraState;
  count?: number;
}

export interface AgentServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

export function startServer(client: LumixClient, config: AgentConfig): Promise<AgentServer> {
  const sseClients = new Set<http.ServerResponse>();
  const catalog = new PhotoCatalog(config, client);
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
    catalog.clear();
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

  const handlePhotos = async (res: http.ServerResponse, refresh: boolean): Promise<void> => {
    if (!client.isConnected) {
      sendJson(res, 409, { error: "not connected — connect to the camera first" });
      return;
    }
    try {
      // Browse on first request or when explicitly asked to refresh.
      if (refresh || catalog.size === 0) {
        await catalog.refresh((message) => broadcast({ type: "info", time: now(), message }));
        broadcast({ type: "photos", time: now(), count: catalog.size });
      }
      const photos = catalog.list().map(toSummary);
      sendJson(res, 200, { count: photos.length, photos });
    } catch (err) {
      const message = (err as Error).message;
      broadcast({ type: "error", time: now(), message: `browse failed: ${message}` });
      sendJson(res, 502, { error: message });
    }
  };

  /** Stream bytes from a camera media URL through the agent to the browser. */
  const proxyMedia = async (
    res: http.ServerResponse,
    mediaUrl: string,
    downloadName?: string,
  ): Promise<void> => {
    try {
      const upstream = await fetch(mediaUrl);
      if (!upstream.ok || !upstream.body) {
        sendJson(res, 502, { error: `upstream responded ${upstream.status}` });
        return;
      }
      const headers: Record<string, string> = {};
      const contentType = upstream.headers.get("content-type");
      const contentLength = upstream.headers.get("content-length");
      headers["content-type"] = contentType ?? "application/octet-stream";
      if (contentLength) headers["content-length"] = contentLength;
      if (downloadName) {
        headers["content-disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
      } else {
        headers["cache-control"] = "public, max-age=3600";
      }
      res.writeHead(200, headers);
      // upstream.body is a web ReadableStream; adapt it to a Node stream.
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 502, { error: (err as Error).message });
      else res.end();
    }
  };

  const handleThumb = async (res: http.ServerResponse, id: string): Promise<void> => {
    const photo = catalog.get(id);
    if (!photo?.thumbnailUrl) {
      sendJson(res, 404, { error: "no thumbnail for this photo" });
      return;
    }
    await proxyMedia(res, photo.thumbnailUrl);
  };

  const handleFile = async (
    res: http.ServerResponse,
    id: string,
    kind: string | null,
  ): Promise<void> => {
    const photo = catalog.get(id);
    if (!photo) {
      sendJson(res, 404, { error: "unknown photo id" });
      return;
    }
    const wantRaw = kind === "raw";
    const url = wantRaw ? photo.rawUrl : photo.jpegUrl;
    if (!url) {
      sendJson(res, 404, { error: `no ${wantRaw ? "raw" : "jpeg"} for this photo` });
      return;
    }
    // Attachment filename so a click saves the original file name.
    await proxyMedia(res, url, photo.title);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    void (async () => {
      try {
        // Parameterized photo routes (id is URL-encoded in the path).
        if (req.method === "GET") {
          const thumb = PHOTO_THUMB_RE.exec(url.pathname);
          if (thumb) return await handleThumb(res, decodeURIComponent(thumb[1] as string));
          const file = PHOTO_FILE_RE.exec(url.pathname);
          if (file) {
            return await handleFile(res, decodeURIComponent(file[1] as string), url.searchParams.get("kind"));
          }
        }

        switch (route) {
          case "GET /":
          case "GET /index.html":
            return await handleStatic(res);
          case "GET /api/status":
            return handleStatus(res);
          case "GET /api/events":
            return handleEvents(req, res);
          case "GET /api/photos":
            return await handlePhotos(res, url.searchParams.get("refresh") === "1");
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
