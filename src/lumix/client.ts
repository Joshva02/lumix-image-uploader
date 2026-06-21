import { EventEmitter } from "node:events";
import type { AgentConfig } from "../config.ts";
import { camCgiOk, camCgiRaw, CamCgiError, type CamCgiOptions } from "./camCgi.ts";
import { isOkResult, parseState } from "./xml.ts";

/**
 * Snapshot of the camera state returned by `getstate`. The exact keys vary by
 * model/firmware, so the raw map is always exposed alongside the common fields.
 */
export interface CameraState {
  /** `<result>` was ok. */
  ok: boolean;
  /** e.g. "rec" or "play". Present once a mode is set. */
  cammode?: string;
  /** e.g. "3/3". */
  batt?: string;
  /** Remaining still capacity, when reported. */
  remaincapacity?: string;
  /** All `<state>` children, untouched. */
  raw: Record<string, string>;
}

export type LumixClientEvents = {
  connected: [{ guid: string; name: string }];
  state: [CameraState];
  "keepalive-error": [Error];
  disconnected: [];
};

/**
 * Phase-1 client: proves and holds the camera link.
 *
 * Responsibilities are deliberately narrow — handshake, getstate, and the
 * keep-alive loop that stops the camera from dropping the Wi-Fi session.
 * Browsing, transfer, and the REST/WebSocket surface come in later phases.
 */
export class LumixClient extends EventEmitter<LumixClientEvents> {
  private readonly config: AgentConfig;
  private readonly cgi: CamCgiOptions;
  private keepAliveTimer?: NodeJS.Timeout;
  private connected = false;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
    this.cgi = {
      host: config.host,
      port: config.port,
      timeoutMs: config.requestTimeoutMs,
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get target(): string {
    return `${this.config.host}:${this.config.port}`;
  }

  /**
   * Register this agent as the controlling device. After this the camera shows
   * "under remote control" and accepts further cam.cgi commands. The camera
   * remembers the GUID, so re-running with the same GUID is a no-op handshake.
   */
  async connect(): Promise<void> {
    await camCgiOk(this.cgi, [
      ["mode", "accctrl"],
      ["type", "req_acc"],
      ["value", this.config.controllerGuid],
      ["value2", this.config.controllerName],
    ]);
    this.connected = true;
    this.emit("connected", {
      guid: this.config.controllerGuid,
      name: this.config.controllerName,
    });
  }

  /** Query `getstate` once and return a parsed snapshot. */
  async getState(): Promise<CameraState> {
    const body = await camCgiRaw(this.cgi, [["mode", "getstate"]]);
    const raw = parseState(body);
    const state: CameraState = {
      ok: isOkResult(body),
      cammode: raw["cammode"],
      batt: raw["batt"],
      remaincapacity: raw["remaincapacity"],
      raw,
    };
    return state;
  }

  /**
   * Start polling `getstate` on an interval to hold the Wi-Fi session open.
   * Emits `state` on every successful poll and `keepalive-error` on failures
   * (without tearing down — a single dropped poll is usually transient).
   */
  startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    const tick = async (): Promise<void> => {
      try {
        const state = await this.getState();
        this.emit("state", state);
      } catch (err) {
        this.emit("keepalive-error", err as Error);
      }
    };
    // Fire immediately, then on the configured cadence.
    void tick();
    this.keepAliveTimer = setInterval(() => void tick(), this.config.keepAliveIntervalMs);
    // Don't keep the process alive solely for the keep-alive timer.
    this.keepAliveTimer.unref?.();
  }

  /** Stop the keep-alive loop and release the camera's remote-control lock. */
  async disconnect(): Promise<void> {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    if (this.connected) {
      try {
        await camCgiRaw(this.cgi, [
          ["mode", "accctrl"],
          ["type", "stop_acc"],
          ["value", this.config.controllerGuid],
        ]);
      } catch (err) {
        // Best-effort release; the camera also times the session out on its own.
        if (!(err instanceof CamCgiError)) throw err;
      }
      this.connected = false;
      this.emit("disconnected");
    }
  }
}
