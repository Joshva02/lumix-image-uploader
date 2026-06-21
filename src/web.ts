#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadConfig, type AgentConfig } from "./config.ts";
import { LumixClient } from "./lumix/client.ts";
import { discoverLumix } from "./lumix/discovery.ts";
import { startServer } from "./server/httpServer.ts";

/**
 * Phase-1 web entry: run the agent and serve its UI over plain
 * `http://localhost`. The browser talks only to this agent — never to the
 * camera — so there's no HTTPS-to-HTTP mixed-content or CORS wall. Open the
 * printed URL and drive the connection from the page.
 *
 * Usage:
 *   npm run web -- [options]
 *
 * Options:
 *   --host <ip>      Camera IP (default 192.168.54.1, the AP-mode address)
 *   --discover       Find the camera via SSDP (use this in client mode)
 *   --name <name>    Controller name shown on the camera
 *   --interval <ms>  Keep-alive poll interval (default 5000)
 *   --port <n>       Web UI port (default 4545)
 *   --open           Try to open the page in your default browser
 *   -h, --help       Show this help
 */

interface CliArgs {
  host?: string;
  discover: boolean;
  name?: string;
  interval?: number;
  port?: number;
  open: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { discover: false, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--host": args.host = argv[++i]; break;
      case "--discover": args.discover = true; break;
      case "--name": args.name = argv[++i]; break;
      case "--interval": args.interval = Number(argv[++i]); break;
      case "--port": args.port = Number(argv[++i]); break;
      case "--open": args.open = true; break;
      case "-h": case "--help": args.help = true; break;
      default: console.warn(`Ignoring unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const HELP = `lumix-agent web — phase-1 agent with a browser UI

Usage: npm run web -- [options]

Options:
  --host <ip>      Camera IP (default 192.168.54.1, the AP-mode address)
  --discover       Find the camera via SSDP (use this in client mode)
  --name <name>    Controller name shown on the camera
  --interval <ms>  Keep-alive poll interval (default 5000)
  --port <n>       Web UI port (default 4545)
  --open           Try to open the page in your default browser
  -h, --help       Show this help

Then open the printed URL and click "Connect".
`;

const ts = (): string => new Date().toISOString().slice(11, 19);

/** Best-effort browser open across platforms; failure is non-fatal. */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => { /* no browser available (e.g. headless) — ignore */ });
    child.unref();
  } catch {
    /* ignore */
  }
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
  if (args.port && !Number.isNaN(args.port)) overrides.webPort = args.port;

  if (args.discover && !args.host) {
    const cfg = loadConfig();
    console.log(`[${ts()}] discovering camera via SSDP (${cfg.discoveryTimeoutMs}ms)...`);
    const device = await discoverLumix(cfg.discoveryTimeoutMs);
    if (device) {
      overrides.host = device.host;
      console.log(`[${ts()}] found camera at ${device.host}${device.server ? ` (${device.server})` : ""}`);
    } else {
      console.warn(`[${ts()}] no camera found via SSDP — UI will start anyway; pass --host or retry from the page.`);
    }
  }

  const config = loadConfig(overrides);
  const client = new LumixClient(config);
  const agent = await startServer(client, config);

  console.log("");
  console.log(`  Lumix agent UI:  ${agent.url}`);
  console.log(`  Target camera:   ${client.target}`);
  console.log(`  Open the URL and click "Connect". Ctrl+C to stop.`);
  console.log("");

  if (args.open) openBrowser(agent.url);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[${ts()}] ${signal} — releasing camera and stopping server...`);
      await client.disconnect();
      await agent.close();
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
