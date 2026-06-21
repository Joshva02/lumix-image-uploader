import { attrOf, tagText, unescapeXml } from "./xml.ts";

/**
 * UPnP/DLNA ContentDirectory access — how the agent browses the card.
 *
 * The camera is a UPnP MediaServer. We read its device description to find the
 * ContentDirectory service, then POST SOAP `Browse` actions whose reply is a
 * DIDL-Lite document. Each photo is a DIDL `<item>` carrying several `<res>`
 * URLs — a thumbnail, a full JPEG, and (for RAW shots) the RW2. We never
 * hardcode those URLs; we read them from the browse response at runtime.
 *
 * As with xml.ts, the parsing here is deliberately targeted at these specific,
 * machine-generated responses rather than being a general XML/SOAP stack.
 */

const CDS_TYPE = "urn:schemas-upnp-org:service:ContentDirectory:1";

export type MediaKind = "thumbnail" | "jpeg" | "raw" | "other";

export interface MediaRes {
  url: string;
  kind: MediaKind;
  protocolInfo?: string;
  size?: number;
  resolution?: string;
}

export interface Photo {
  /** UPnP object id — stable handle we expose to the front end. */
  id: string;
  title: string;
  date?: string;
  res: MediaRes[];
  /** Best pick per kind, resolved from the res list. */
  thumbnailUrl?: string;
  jpegUrl?: string;
  rawUrl?: string;
}

/**
 * Find the ContentDirectory control URL in a UPnP device description, resolved
 * to an absolute URL against `<URLBase>` (if present) or the description URL.
 */
export function parseDeviceDescription(xml: string, descriptionUrl: string): string | undefined {
  const base = tagText(xml, "URLBase") || descriptionUrl;
  for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const block = m[1] ?? "";
    if (/ContentDirectory/i.test(block)) {
      const controlUrl = tagText(block, "controlURL");
      if (controlUrl) return new URL(controlUrl.trim(), base).toString();
    }
  }
  return undefined;
}

export interface BrowseResult {
  didl: string;
  numberReturned: number;
  totalMatches: number;
}

/** Issue one SOAP `Browse` (BrowseDirectChildren) and return the DIDL payload. */
export async function soapBrowse(
  controlUrl: string,
  objectId: string,
  startIndex: number,
  requestedCount: number,
  timeoutMs: number,
): Promise<BrowseResult> {
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:Browse xmlns:u="${CDS_TYPE}">` +
    `<ObjectID>${objectId}</ObjectID>` +
    `<BrowseFlag>BrowseDirectChildren</BrowseFlag>` +
    `<Filter>*</Filter>` +
    `<StartingIndex>${startIndex}</StartingIndex>` +
    `<RequestedCount>${requestedCount}</RequestedCount>` +
    `<SortCriteria></SortCriteria>` +
    `</u:Browse></s:Body></s:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${CDS_TYPE}#Browse"`,
      },
      body: envelope,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ContentDirectory Browse failed: HTTP ${res.status}`);
    }
    return {
      didl: unescapeXml(tagText(text, "Result") ?? ""),
      numberReturned: Number(tagText(text, "NumberReturned") ?? "0") || 0,
      totalMatches: Number(tagText(text, "TotalMatches") ?? "0") || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Classify a `<res>` by its protocolInfo / mime so we can pick thumb/jpeg/raw. */
function classifyRes(protocolInfo: string): MediaKind {
  const p = protocolInfo.toLowerCase();
  if (p.includes("rw2") || p.includes("x-panasonic-raw") || p.includes("x-raw") || p.includes("/raw")) {
    return "raw";
  }
  if (p.includes("jpeg_tn") || p.includes("_tn") || p.includes("thumbnail")) return "thumbnail";
  if (p.includes("jpeg") || p.includes("image/")) return "jpeg";
  return "other";
}

function parseResList(itemXml: string): MediaRes[] {
  const list: MediaRes[] = [];
  for (const m of itemXml.matchAll(/<res\b([^>]*)>([\s\S]*?)<\/res>/gi)) {
    const attrs = m[1] ?? "";
    const url = unescapeXml((m[2] ?? "").trim());
    if (!url) continue;
    const protocolInfo = attrOf(attrs, "protocolInfo");
    const size = Number(attrOf(attrs, "size") ?? "");
    list.push({
      url,
      protocolInfo,
      size: Number.isFinite(size) && size > 0 ? size : undefined,
      resolution: attrOf(attrs, "resolution"),
      kind: classifyRes(protocolInfo ?? ""),
    });
  }
  return list;
}

function bySizeAsc(a: MediaRes, b: MediaRes): number {
  return (a.size ?? 0) - (b.size ?? 0);
}

function buildPhoto(id: string, title: string, date: string | undefined, res: MediaRes[]): Photo {
  const thumbs = res.filter((r) => r.kind === "thumbnail").sort(bySizeAsc);
  const jpegs = res.filter((r) => r.kind === "jpeg").sort(bySizeAsc);
  const raws = res.filter((r) => r.kind === "raw");
  // Smallest thumbnail if present, else the smallest JPEG as a stand-in.
  const thumbnailUrl = (thumbs[0] ?? jpegs[0])?.url;
  // Largest JPEG is the full-resolution one.
  const jpegUrl = jpegs.at(-1)?.url;
  const rawUrl = raws[0]?.url;
  return { id, title, date, res, thumbnailUrl, jpegUrl, rawUrl };
}

export interface DidlParse {
  containers: Array<{ id: string; title: string }>;
  items: Photo[];
}

/** Parse a DIDL-Lite document into its containers (to recurse into) and items. */
export function parseDidl(didl: string): DidlParse {
  const containers: Array<{ id: string; title: string }> = [];
  for (const m of didl.matchAll(/<container\b([^>]*)>([\s\S]*?)<\/container>/gi)) {
    const id = attrOf(m[1] ?? "", "id");
    if (id) containers.push({ id, title: unescapeXml(tagText(m[2] ?? "", "dc:title") ?? "") });
  }

  const items: Photo[] = [];
  for (const m of didl.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/gi)) {
    const id = attrOf(m[1] ?? "", "id");
    if (!id) continue;
    const inner = m[2] ?? "";
    const title = unescapeXml(tagText(inner, "dc:title") ?? id);
    const date = tagText(inner, "dc:date");
    items.push(buildPhoto(id, title, date, parseResList(inner)));
  }

  return { containers, items };
}

export interface BrowseAllOptions {
  timeoutMs: number;
  pageSize?: number;
  maxItems?: number;
  maxBrowses?: number;
}

/**
 * Walk the ContentDirectory from the root, recursing into containers and paging
 * through children, and return every photo found. Bounded by `maxItems` and
 * `maxBrowses` so a huge card or an odd server can't run away.
 */
export async function browseAll(controlUrl: string, opts: BrowseAllOptions): Promise<Photo[]> {
  const pageSize = opts.pageSize ?? 50;
  const maxItems = opts.maxItems ?? 5000;
  const maxBrowses = opts.maxBrowses ?? 500;

  const photos = new Map<string, Photo>();
  const queue: string[] = ["0"];
  const seen = new Set<string>();
  let browses = 0;

  while (queue.length > 0 && photos.size < maxItems && browses < maxBrowses) {
    const objectId = queue.shift() as string;
    if (seen.has(objectId)) continue;
    seen.add(objectId);

    let start = 0;
    for (;;) {
      browses++;
      const { didl, numberReturned, totalMatches } = await soapBrowse(
        controlUrl,
        objectId,
        start,
        pageSize,
        opts.timeoutMs,
      );
      if (!didl) break;

      const { containers, items } = parseDidl(didl);
      for (const item of items) photos.set(item.id, item);
      for (const c of containers) if (!seen.has(c.id)) queue.push(c.id);

      const advanced = numberReturned || items.length + containers.length;
      if (advanced === 0) break;
      start += advanced;
      if (totalMatches && start >= totalMatches) break;
      if (browses >= maxBrowses || photos.size >= maxItems) break;
    }
  }

  return [...photos.values()];
}
