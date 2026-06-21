# lumix-image-uploader

Fast image offload from a Panasonic **Lumix DC-S5** over Wi-Fi — built for
*workflow* speed (thumbnails-first triage, JPG-only quick pull, selective and
background downloading), not raw link throughput. The camera's Wi-Fi is the real
bottleneck, so the architecture optimises for "see everything instantly, pull
only what you want, in the background" rather than trying to out-run USB.

> **Status: Phases 1–2.** The agent proves and holds the camera link (handshake
> + keep-alive + `getstate`) **and** browses the card over UPnP to render a
> thumbnail gallery, drivable from a [CLI](#usage) or a [browser UI](#web-ui-front-end).
> Resumable/background downloads and the polished workflow come next — see
> [Roadmap](#roadmap).

## Architecture (where this is heading)

Two links, working differently:

- **Camera ↔ agent** — the undocumented Lumix Wi-Fi protocol: plain HTTP
  `cam.cgi` calls for control, plus DLNA/UPnP (ContentDirectory) for browsing and
  pulling files off the card.
- **Agent ↔ web app** — normal REST for actions plus a WebSocket so the gallery
  updates live as files land. The web app never talks to the camera directly —
  that's what dodges the browser's mixed-content and CORS walls.

This repo is the **local agent** (Node + TypeScript). Phase 1 implements the
first of its five jobs.

## What phase 1 does

1. **Discovery / connect** — either point at the camera's AP-mode address
   (`192.168.54.1`) or, better, let the camera join *your* network (client mode)
   and find it via SSDP so your laptop keeps its internet.
2. **Handshake** — registers this agent as the controlling device
   (`cam.cgi?mode=accctrl&type=req_acc&value=<GUID>&value2=<name>`). The camera
   then shows "under remote control".
3. **`getstate` probe** — one immediate state read to confirm the link is live.
4. **Keep-alive** — polls `cam.cgi?mode=getstate` every ~5s to hold the Wi-Fi
   session open. **This is the single most common reason naive scripts
   "randomly" disconnect** — skip it and the camera drops you.
5. **Clean release** — on Ctrl+C, releases the remote-control lock
   (`type=stop_acc`).

If this stays connected and prints state every few seconds, the rest of the
agent is worth building on top.

## Requirements

- Node.js **>= 20** (developed on Node 22; uses built-in `fetch` and `dgram`,
  zero runtime dependencies).
- A Lumix DC-S5 with Wi-Fi enabled, on the same network as this machine (client
  mode) or with this machine joined to the camera's AP.

## Setup

```bash
npm install        # installs TypeScript + @types/node (dev only)
```

## Usage

Run directly from TypeScript (Node strips types, no build step):

```bash
# AP mode: join the camera's Wi-Fi, then point at its fixed address
npm run dev -- --host 192.168.54.1

# Client mode: camera joined your network — discover it via SSDP
npm run dev -- --discover

# One-shot: handshake + a single getstate, then exit (no keep-alive loop)
npm run dev -- --host 192.168.54.1 --once

# Show all options
npm run dev -- --help
```

Or build and run the compiled output:

```bash
npm run build
npm start -- --discover
```

## Web UI (front end)

You don't have to use the CLI — the agent can serve a small browser UI and you
drive everything from the page. **The browser talks only to the agent over plain
`http://localhost`; it never talks to the camera.** That's deliberate: it sidesteps
the browser's HTTPS-to-HTTP mixed-content block and CORS entirely, because all the
camera I/O happens in the agent.

### Run it

```bash
npm install            # first time only

# AP mode (joined the camera's Wi-Fi):
npm run web -- --host 192.168.54.1

# Client mode (camera on your network) — discover + auto-open the browser:
npm run web -- --discover --open
```

You'll see:

```
  Lumix agent UI:  http://localhost:4545
  Target camera:   192.168.54.1:80
  Open the URL and click "Connect". Ctrl+C to stop.
```

Open <http://localhost:4545>, click **Connect**, and the page shows the
connection badge, live camera state (mode / battery / capacity), and a streaming
log that updates on every keep-alive tick. Then click **Load photos** to switch
the camera to playback, browse the card, and render a thumbnail **gallery** — each
tile shows the file name, RAW/JPG badges, and links to open the full JPG or
download the RW2. Filter by JPG/RAW, and **Refresh** to re-browse. Click
**Disconnect** (or Ctrl+C in the terminal) to release the camera cleanly.

> Thumbnails and files are **proxied through the agent** — the browser requests
> `/api/photos/:id/thumb`, never the camera directly — so the same
> mixed-content/CORS-free guarantee holds for image bytes too.

### Options

Same as the CLI, plus `--port <n>` (web UI port, default `4545`) and `--open`
(try to open your default browser). Run `npm run web -- --help` for the full
list. The web UI port is also settable via `LUMIX_WEB_PORT`.

### How the page talks to the agent

The front end is plain HTML/CSS/JS in [`public/index.html`](public/index.html) —
no framework, no build step. It uses a tiny REST + Server-Sent-Events surface the
agent exposes:

| Method & path        | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `GET  /`             | The front-end page.                                           |
| `GET  /api/status`   | JSON snapshot: target, connected, last state.                 |
| `GET  /api/events`   | Server-Sent Events stream of live connection + state updates. |
| `POST /api/connect`  | Handshake + start keep-alive. Returns the error + a hint on failure. |
| `POST /api/disconnect` | Stop keep-alive + release the camera.                       |
| `GET  /api/photos`   | Switch to playback, browse the card via UPnP, list photos. `?refresh=1` re-browses. |
| `GET  /api/photos/:id/thumb` | Proxied thumbnail bytes for one photo.                |
| `GET  /api/photos/:id/file?kind=jpeg\|raw` | Proxied full JPG or RW2 (download). |

> SSE (browser `EventSource`) keeps the agent dependency-free and is enough for
> one-way live updates in phase 1. Phase 4 upgrades this to a WebSocket when the
> gallery needs bidirectional/binary download-progress messages.

### Building your own front end on top

If you'd rather build the gallery in React (per the roadmap), point it at the
same `http://localhost:<port>` REST + SSE endpoints above — keep it served from,
or proxied through, the agent's origin so there's no mixed-content/CORS block.
The endpoint surface grows in later phases (`/api/photos`, `/api/photos/:id/download`).

### Options

| Flag              | Meaning                                                      |
| ----------------- | ----------------------------------------------------------- |
| `--host <ip>`     | Camera IP (default `192.168.54.1`, the AP-mode address).    |
| `--discover`      | Find the camera via SSDP (use this in client mode).         |
| `--name <name>`   | Controller name shown on the camera.                        |
| `--interval <ms>` | Keep-alive poll interval (default `5000`).                  |
| `--once`          | Handshake + one `getstate`, then exit.                      |
| `-h`, `--help`    | Show help.                                                  |

### Environment overrides

All config is also settable via env vars (handy for a stable controller
identity): `LUMIX_HOST`, `LUMIX_PORT`, `LUMIX_CONTROLLER_NAME`, `LUMIX_GUID`,
`LUMIX_KEEPALIVE_MS`, `LUMIX_TIMEOUT_MS`, `LUMIX_DISCOVERY_MS`, `LUMIX_WEB_PORT`,
`LUMIX_CDS_DESCRIPTION_URL` (skip SSDP and point straight at the camera's UPnP
description URL — useful when SSDP is flaky).

> Tip: set a fixed `LUMIX_GUID` so the camera recognises this agent as the same
> controller across runs.

### Example output

```
[18:02:11] target camera: 192.168.54.1:80
[18:02:11] performing access handshake...
[18:02:11] connected — registered as "lumix-image-uploader" (4D454930-...)
[18:02:12] getstate ok — mode=play batt=3/3 cap=01234
[18:02:12] holding link with getstate every 5000ms. Press Ctrl+C to stop.
[18:02:17] keep-alive — mode=play batt=3/3 cap=01234
^C
[18:02:19] SIGINT received — releasing camera...
[18:02:19] disconnected. Bye.
```

## Project layout

```
public/
  index.html          Front end: status, live state, gallery grid (no build)
src/
  index.ts            CLI entry: discover → handshake → probe → keep-alive
  web.ts              Web entry: run the agent + serve the UI over http://localhost
  config.ts           Config + env overrides
  server/
    httpServer.ts     REST + SSE surface the browser talks to (never the camera)
  lumix/
    camCgi.ts         Low-level cam.cgi HTTP transport (timeout, result check)
    client.ts         LumixClient: connect / playback / getState / keep-alive
    discovery.ts      SSDP (UPnP) discovery for client mode
    contentDirectory.ts  UPnP device-description + SOAP Browse + DIDL-Lite parsing
    catalog.ts        PhotoCatalog: playback → locate CDS → browse → cache
    xml.ts            Minimal XML field extraction for cam.cgi / DIDL replies
```

## Scripts

| Script              | Does                                                   |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Run the CLI from source via Node's TypeScript strip mode. |
| `npm run web`       | Run the agent + browser UI from source.                |
| `npm run build`     | Compile to `dist/`.                                    |
| `npm start`         | Run the compiled CLI (`dist/index.js`).                |
| `npm run start:web` | Run the compiled web agent (`dist/web.js`).            |
| `npm run typecheck` | Type-check without emitting.                           |

## Troubleshooting

- **Handshake fails / "fetch failed"** — camera Wi-Fi off, wrong `--host`, or the
  camera is already locked by the Lumix Sync app. Close the app and retry.
- **Connects then drops after a while** — the keep-alive loop isn't running (you
  used `--once`, or the interval is too long). The camera needs to hear from a
  controller regularly.
- **`--discover` finds nothing** — the camera must be in client mode and on this
  network. Some firmware doesn't answer the `MediaServer` SSDP search until it's
  in playback mode; fall back to `--host` with the camera's DHCP address.

## Roadmap

Phase 1 (this repo) de-risks the unknown — the link itself — before anything is
built on top.

1. **Prove the link** ✅ — handshake, keep-alive, `getstate`.
2. **Browse + thumbnails** ✅ — switch to playback (`camcmd&value=playmode`), walk
   the UPnP ContentDirectory, list every shot with its thumbnail in a gallery
   grid (with JPG/RAW filter and per-file open/download links).
3. **Selective download** — pull a chosen JPG, then a chosen RW2, with
   resume-on-failure (HTTP range requests) and live progress. *(Files already
   download via the proxy; phase 3 adds resume + progress + save-to-disk.)*
4. **Web app polish** — richer gallery, WebSocket progress bars, bulk select.
5. **Workflow polish** — background auto-pull of new shots, JPG-only fast mode,
   bulk select, auto-save to a watched folder / NAS / cloud.

## Notes & honesty

- The Lumix Wi-Fi protocol is **undocumented and reverse-engineered**. Treat the
  command set as "works today," not a contract — Panasonic can change it in
  firmware. Useful references for the exact request sequences:
  [`palmdalian/python_lumix_control`](https://github.com/palmdalian/python_lumix_control)
  (command set) and `totoantibes/LumixCameraAscomDriver` (capture-then-download
  RW2 logic).
- The official USB SDK does list the DC-S5, but it's C++, Windows/Mac only, and
  slower to integrate than the Wi-Fi path for this use case.
