import dgram from "node:dgram";

/**
 * SSDP (UPnP) discovery for the camera when it has joined your network in
 * client mode. In AP mode you don't need this — the camera is always at
 * 192.168.54.1 — but client mode is the better workflow (your laptop keeps its
 * internet), and then the camera's address is whatever your router handed it.
 *
 * We send an M-SEARCH for UPnP root devices and keep any responder that looks
 * like a Panasonic MediaServer. The camera advertises a ContentDirectory we'll
 * use for browsing in phase 2, so MediaServer is the right target.
 */

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

export interface DiscoveredDevice {
  /** IP address the SSDP reply came from. */
  host: string;
  /** LOCATION header — URL of the device description XML. */
  location?: string;
  /** SERVER header — often contains "Panasonic". */
  server?: string;
  /** USN / ST headers for identification. */
  usn?: string;
  st?: string;
}

function parseSsdpHeaders(message: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return headers;
}

/** Heuristic: does this responder look like a Lumix/Panasonic camera? */
function looksLikeLumix(d: DiscoveredDevice): boolean {
  const haystack = `${d.server ?? ""} ${d.usn ?? ""} ${d.st ?? ""} ${d.location ?? ""}`.toLowerCase();
  return haystack.includes("panasonic") || haystack.includes("lumix") || haystack.includes("mediaserver");
}

/**
 * Broadcast an M-SEARCH and collect responders for `timeoutMs`. Returns devices
 * that look like a Lumix camera first, but includes all responders so the
 * caller can fall back if the heuristic misses.
 */
export async function discover(timeoutMs: number): Promise<DiscoveredDevice[]> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const found = new Map<string, DiscoveredDevice>();

  const query = [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 2",
    // MediaServer covers the camera's ContentDirectory; also try root devices.
    "ST: urn:schemas-upnp-org:device:MediaServer:1",
    "",
    "",
  ].join("\r\n");

  return new Promise<DiscoveredDevice[]>((resolve, reject) => {
    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });

    socket.on("message", (msg, rinfo) => {
      const headers = parseSsdpHeaders(msg.toString());
      const device: DiscoveredDevice = {
        host: rinfo.address,
        location: headers["location"],
        server: headers["server"],
        usn: headers["usn"],
        st: headers["st"],
      };
      // Key by host+usn so multiple NIC replies from one device collapse.
      found.set(`${device.host}|${device.usn ?? ""}`, device);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        const buf = Buffer.from(query);
        socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
        // Also send an all-root-devices search to catch firmware that doesn't
        // answer the MediaServer ST.
        const rootQuery = Buffer.from(query.replace(/ST: .*/, "ST: ssdp:all"));
        socket.send(rootQuery, 0, rootQuery.length, SSDP_PORT, SSDP_ADDR);
      } catch (err) {
        socket.close();
        reject(err);
        return;
      }

      setTimeout(() => {
        socket.close();
        const devices = [...found.values()];
        devices.sort((a, b) => Number(looksLikeLumix(b)) - Number(looksLikeLumix(a)));
        resolve(devices);
      }, timeoutMs);
    });
  });
}

/** Convenience: return the first responder that looks like a Lumix camera. */
export async function discoverLumix(timeoutMs: number): Promise<DiscoveredDevice | undefined> {
  const devices = await discover(timeoutMs);
  return devices.find(looksLikeLumix);
}
