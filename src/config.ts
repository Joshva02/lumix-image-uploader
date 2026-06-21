import { randomUUID } from "node:crypto";

/**
 * Phase-1 agent configuration.
 *
 * Everything here can be overridden by environment variables so the link can be
 * proven against a real camera without editing code. See README for the meaning
 * of each value and how to discover the camera host.
 */
export interface AgentConfig {
  /** Camera IP. Default AP mode address is 192.168.54.1; in client mode use the
   *  address the camera got on your network (or let SSDP discovery find it). */
  host: string;
  /** cam.cgi is served over plain HTTP on port 80. */
  port: number;
  /** Name shown on the camera as the controlling device. */
  controllerName: string;
  /** Stable GUID identifying this controller during the access handshake.
   *  The camera remembers registered controllers, so keep this stable. */
  controllerGuid: string;
  /** Keep-alive poll interval (ms). The camera drops the Wi-Fi session if it
   *  doesn't hear from us; ~5s is the proven safe value. */
  keepAliveIntervalMs: number;
  /** Per-request timeout (ms) for cam.cgi calls. */
  requestTimeoutMs: number;
  /** How long to listen for SSDP replies during discovery (ms). */
  discoveryTimeoutMs: number;
}

/**
 * A GUID in the dashed form the Lumix handshake expects. Reuses an env-provided
 * value when present so the same controller identity persists across runs.
 */
function defaultGuid(): string {
  return process.env.LUMIX_GUID ?? randomUUID().toUpperCase();
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    host: process.env.LUMIX_HOST ?? "192.168.54.1",
    port: Number(process.env.LUMIX_PORT ?? 80),
    controllerName: process.env.LUMIX_CONTROLLER_NAME ?? "lumix-image-uploader",
    controllerGuid: defaultGuid(),
    keepAliveIntervalMs: Number(process.env.LUMIX_KEEPALIVE_MS ?? 5000),
    requestTimeoutMs: Number(process.env.LUMIX_TIMEOUT_MS ?? 8000),
    discoveryTimeoutMs: Number(process.env.LUMIX_DISCOVERY_MS ?? 4000),
    ...overrides,
  };
}
