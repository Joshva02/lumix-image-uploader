import { isOkResult } from "./xml.ts";

/**
 * Low-level transport for the camera's undocumented HTTP control interface.
 *
 * Every command is a GET to `http://<host>/cam.cgi` with query parameters. The
 * camera replies with a small XML document whose `<result>` tag is `ok` on
 * success. This module owns the URL building, timeout, and result check; higher
 * layers deal in typed commands.
 */

export class CamCgiError extends Error {
  readonly url: string;
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, url: string, status?: number, body?: string) {
    super(message);
    this.name = "CamCgiError";
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export interface CamCgiOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/**
 * Issue one cam.cgi request and return the raw XML body.
 *
 * `params` are appended as-is (already-encoded by URLSearchParams). The camera
 * is picky about parameter order for some commands, so callers pass an ordered
 * array of [key, value] pairs rather than an object.
 */
export async function camCgiRaw(
  opts: CamCgiOptions,
  params: Array<[string, string]>,
): Promise<string> {
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `http://${opts.host}:${opts.port}/cam.cgi?${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // The camera speaks HTTP/1.0-ish; keep headers minimal.
      headers: { Accept: "text/xml" },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new CamCgiError(`HTTP ${res.status} from cam.cgi`, url, res.status, body);
    }
    return body;
  } catch (err) {
    if (err instanceof CamCgiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new CamCgiError(`cam.cgi request timed out after ${opts.timeoutMs}ms`, url);
    }
    throw new CamCgiError(
      `cam.cgi request failed: ${(err as Error).message}`,
      url,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Issue a cam.cgi request and assert the reply is `<result>ok</result>`.
 * Returns the raw body so callers can still parse additional fields.
 */
export async function camCgiOk(
  opts: CamCgiOptions,
  params: Array<[string, string]>,
): Promise<string> {
  const body = await camCgiRaw(opts, params);
  if (!isOkResult(body)) {
    const url = `http://${opts.host}:${opts.port}/cam.cgi?...`;
    throw new CamCgiError(`cam.cgi returned non-ok result`, url, undefined, body);
  }
  return body;
}
