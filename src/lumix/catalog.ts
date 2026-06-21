import type { AgentConfig } from "../config.ts";
import type { LumixClient } from "./client.ts";
import { discoverByHost, discoverLumix } from "./discovery.ts";
import { browseAll, parseDeviceDescription, type Photo } from "./contentDirectory.ts";

/**
 * The card's photo catalog: switches the camera to playback, locates its
 * ContentDirectory, browses every shot, and caches the result keyed by UPnP id.
 *
 * The control URL is resolved once and reused — only the listing is re-fetched
 * on refresh. Higher layers (the web server) turn `Photo`s into API summaries
 * and proxy the actual bytes.
 */
export class PhotoCatalog {
  private readonly config: AgentConfig;
  private readonly client: LumixClient;
  private photos = new Map<string, Photo>();
  private controlUrl?: string;

  constructor(config: AgentConfig, client: LumixClient) {
    this.config = config;
    this.client = client;
  }

  get size(): number {
    return this.photos.size;
  }

  get(id: string): Photo | undefined {
    return this.photos.get(id);
  }

  list(): Photo[] {
    return [...this.photos.values()];
  }

  /** Drop the cache (e.g. on disconnect). The resolved control URL is kept. */
  clear(): void {
    this.photos.clear();
  }

  /**
   * Re-list the card. Requires an active connection (the keep-alive session must
   * be holding the link). `onProgress` receives short human-readable steps so
   * the UI can show what's happening.
   */
  async refresh(onProgress?: (message: string) => void): Promise<Photo[]> {
    if (!this.client.isConnected) {
      throw new Error("Connect to the camera first.");
    }

    onProgress?.("switching camera to playback mode");
    await this.client.setPlaybackMode();

    if (!this.controlUrl) {
      onProgress?.("locating ContentDirectory");
      this.controlUrl = await this.resolveControlUrl();
    }

    onProgress?.("browsing photos");
    const list = await browseAll(this.controlUrl, { timeoutMs: this.config.requestTimeoutMs });
    this.photos = new Map(list.map((p) => [p.id, p]));
    onProgress?.(`found ${list.length} photo${list.length === 1 ? "" : "s"}`);
    return list;
  }

  /** Resolve the ContentDirectory control URL, via config or SSDP. */
  private async resolveControlUrl(): Promise<string> {
    let location = this.config.cdsDescriptionUrl;
    if (!location) {
      const device =
        (await discoverByHost(this.config.host, this.config.discoveryTimeoutMs)) ??
        (await discoverLumix(this.config.discoveryTimeoutMs));
      location = device?.location;
    }
    if (!location) {
      throw new Error(
        "Could not find the camera's UPnP description via SSDP. Make sure the camera is " +
          "in playback Wi-Fi mode, or set LUMIX_CDS_DESCRIPTION_URL to its description URL.",
      );
    }

    const xml = await fetchText(location, this.config.requestTimeoutMs);
    const controlUrl = parseDeviceDescription(xml, location);
    if (!controlUrl) {
      throw new Error("The camera's UPnP description has no ContentDirectory service.");
    }
    return controlUrl;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
