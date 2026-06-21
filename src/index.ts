#!/usr/bin/env node
import { loadConfig, type AgentConfig } from "./config.ts";
import { LumixClient, type CameraState } from "./lumix/client.ts";
import { CamCgiError } from "./lumix/camCgi.ts";
import { discoverLumix } from "./lumix/discovery.ts";

/**
 * Phase-1 link prover for the Lumix DC-S5 agent.
 *
 * This does exactly three things, in order: discover/select the camera, perform
 * the access handshake, then hold the link open with a getstate keep-alive loop
 * while printing state. If this stays connected, the rest of the agent (browse,
 * transfer, REST/WebSocket) is worth building on top.
 *
 * Usage:
 *   npm run dev -- [options]
 *
 * Options:
 *   --host <ip>        Camera IP (default 192.168.54.1, the AP-mode address)
 *   --discover         Find the camera via SSDP (use this in client mode)
 *   --name <name>      Controller name shown on the camera
 *   --interval <ms>    Keep-alive poll interval (default 5000)
 *   --once             Handshake + one getstate, then exit (no keep-alive loop)
 *   -h, --help         Show this help
 */

interface CliArgs {
  host?: string;
  discover: boolean;
  name?: string;
  interval?: number;
  once: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { discover: false, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        args.host = argv[++i];
        break;
      case "--discover":
        args.discover = true;
        break;
      case "--name":
        args.name = argv[++i];
        break;
      case "--interval":
        args.interval = Number(argv[++i]);
        break;
      case "--once":
        args.once = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        console.warn(`Ignoring unknown argument: ${arg}`);
    }
  }
  return args;
}

const HELP = `lumix-agent — phase-1 link prover for the Lumix DC-S5

Usage: npm run dev -- [options]

Options:
  --host <ip>      Camera IP (default 192.168.54.1, the AP-mode address)
  --discover       Find the camera via SSDP (use this in client mode)
  --name <name>    Controller name shown on the camera
  --interval <ms>  Keep-alive poll interval (default 5000)
  --once           Handshake + one getstate, then exit
  -h, --help       Show this help

Environment overrides: LUMIX_HOST, LUMIX_PORT, LUMIX_CONTROLLER_NAME,
LUMIX_GUID, LUMIX_KEEPALIVE_MS, LUMIX_TIMEOUT_MS, LUMIX_DISCOVERY_MS
`;

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatState(s: CameraState): string {
  const parts = [
    s.cammode ? `mode=${s.cammode}` : undefined,
    s.batt ? `batt=${s.batt}` : undefined,
    s.remaincapacity ? `cap=${s.remaincapacity}` : undefined,
  ].filter(Boolean);
  if (parts.length === 0) {
    // Fall back to whatever fields the camera did send.
    const raw = Object.entries(s.raw).slice(0, 6).map(([k, v]) => `${k}=${v}`);
    return raw.length ? raw.join(" ") : "(no state fields)";
  }
  return parts.join(" ");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const overrides: Partial<AgentConfig> = {};
  if (args.host) overrides.host = args.host;
  if (args.name) overrides.controllerName = args.name;
  if (args.interval && !Number.isNaN(args.interval)) overrides.keepAliveIntervalMs = args.interval;

  // Discovery resolves the host when the camera is in client mode.
  if (args.discover && !args.host) {
    const cfg = loadConfig();
    console.log(`[${ts()}] discovering camera via SSDP (${cfg.discoveryTimeoutMs}ms)...`);
    const device = await discoverLumix(cfg.discoveryTimeoutMs);
    if (!device) {
      console.error(
        `[${ts()}] no Lumix camera found via SSDP. Make sure the camera is on this network ` +
          `and Wi-Fi is enabled, or pass --host <ip> explicitly.`,
      );
      return 2;
    }
    overrides.host = device.host;
    console.log(`[${ts()}] found camera at ${device.host}${device.server ? ` (${device.server})` : ""}`);
  }

  const config = loadConfig(overrides);
  const client = new LumixClient(config);

  client.on("connected", ({ name, guid }) => {
    console.log(`[${ts()}] connected — registered as "${name}" (${guid})`);
  });
  client.on("keepalive-error", (err) => {
    console.warn(`[${ts()}] keep-alive poll failed: ${err.message}`);
  });

  console.log(`[${ts()}] target camera: ${client.target}`);
  console.log(`[${ts()}] performing access handshake...`);

  try {
    await client.connect();
  } catch (err) {
    if (err instanceof CamCgiError) {
      console.error(`[${ts()}] handshake failed: ${err.message}`);
      if (err.body) console.error(`  camera said: ${err.body.trim()}`);
      console.error(
        `  check: camera Wi-Fi on? correct --host? camera not already locked by Lumix Sync app?`,
      );
    } else {
      console.error(`[${ts()}] handshake failed:`, err);
    }
    return 1;
  }

  // One getstate probe so we get an immediate confirmation the link works.
  try {
    const state = await client.getState();
    console.log(`[${ts()}] getstate ok — ${formatState(state)}`);
  } catch (err) {
    console.error(`[${ts()}] getstate probe failed: ${(err as Error).message}`);
    await client.disconnect();
    return 1;
  }

  if (args.once) {
    await client.disconnect();
    console.log(`[${ts()}] --once: done.`);
    return 0;
  }

  // Hold the link open. Without this loop the camera drops the session.
  console.log(
    `[${ts()}] holding link with getstate every ${config.keepAliveIntervalMs}ms. Press Ctrl+C to stop.`,
  );
  client.on("state", (state) => {
    console.log(`[${ts()}] keep-alive — ${formatState(state)}`);
  });
  client.startKeepAlive();

  // Clean shutdown: release the camera's remote-control lock on Ctrl+C.
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[${ts()}] ${signal} received — releasing camera...`);
      await client.disconnect();
      console.log(`[${ts()}] disconnected. Bye.`);
      resolve();
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
