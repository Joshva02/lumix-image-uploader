# lumix-image-uploader

Fast image offload from a Panasonic **Lumix DC-S5** over Wi-Fi — built for
*workflow* speed (thumbnails-first triage, JPG-only quick pull, selective and
background downloading), not raw link throughput. The camera's Wi-Fi is the real
bottleneck, so the architecture optimises for "see everything instantly, pull
only what you want, in the background" rather than trying to out-run USB.

> **Status: Phase 1 — link prover.** This repo currently contains only the local
> agent's first job: prove and hold the camera link (access handshake +
> keep-alive + `getstate` probe). Browse, transfer, and the web app come next.
> See [Roadmap](#roadmap).

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
`LUMIX_KEEPALIVE_MS`, `LUMIX_TIMEOUT_MS`, `LUMIX_DISCOVERY_MS`.

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
src/
  index.ts            CLI entry: discover → handshake → probe → keep-alive
  config.ts           Config + env overrides
  lumix/
    camCgi.ts         Low-level cam.cgi HTTP transport (timeout, result check)
    client.ts         LumixClient: connect / getState / keep-alive / disconnect
    discovery.ts      SSDP (UPnP) discovery for client mode
    xml.ts            Minimal XML field extraction for cam.cgi replies
```

## Scripts

| Script              | Does                                              |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run from source via Node's TypeScript strip mode. |
| `npm run build`     | Compile to `dist/`.                               |
| `npm start`         | Run the compiled `dist/index.js`.                 |
| `npm run typecheck` | Type-check without emitting.                      |

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
2. **Browse + thumbnails** — switch to playback (`camcmd&value=playmode`), walk
   the UPnP ContentDirectory, list every shot with its thumbnail.
3. **Selective download** — pull a chosen JPG, then a chosen RW2, with
   resume-on-failure (HTTP range requests).
4. **Web app** — gallery grid from thumbnails, click to download, WebSocket
   progress bars, JPG/RAW filter.
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
