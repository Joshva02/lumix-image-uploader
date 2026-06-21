/**
 * Minimal XML field extraction for cam.cgi replies.
 *
 * The camera's control responses are tiny, flat, and predictable, e.g.:
 *
 *   <?xml version="1.0"?><camrply><result>ok</result></camrply>
 *
 *   <?xml version="1.0"?><camrply><result>ok</result>
 *     <state><batt>3/3</batt><cammode>play</cammode>...</state></camrply>
 *
 * A full XML parser is overkill here and would add a dependency, so we pull
 * individual tags with a focused regex. This is intentionally not a general
 * XML parser — it is only used for these small, well-known responses.
 */

/** Return the text content of the first `<tag>...</tag>`, or undefined. */
export function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

/** Collect every child tag/value pair inside the first `<state>...</state>`. */
export function parseState(xml: string): Record<string, string> {
  const stateXml = tagText(xml, "state");
  const state: Record<string, string> = {};
  if (!stateXml) return state;
  const childRe = /<(\w+)\b[^>]*>([\s\S]*?)<\/\1>/g;
  for (const m of stateXml.matchAll(childRe)) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) state[key] = value.trim();
  }
  return state;
}

/**
 * cam.cgi reports success as `<result>ok</result>`. Anything else (or a missing
 * result) is an error we want to surface with the raw payload for debugging.
 */
export function isOkResult(xml: string): boolean {
  return tagText(xml, "result")?.toLowerCase() === "ok";
}

/**
 * Decode the standard XML entities. Used to unwrap the DIDL-Lite document the
 * camera embeds (escaped) inside a SOAP `<Result>` element. `&amp;` is decoded
 * last so sequences like `&amp;lt;` survive as `&lt;`.
 */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Value of an XML attribute from a raw tag-attribute string, or undefined. */
export function attrOf(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1];
}
