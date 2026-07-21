import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LIMITS, USER_AGENT } from "./constants.js";

const TRACKING_PARAMETERS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "ref", "source"
]);

export class AuditError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    this.details = details;
  }
}

function privateIpv4(address) {
  const values = address.split(".").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value))) return true;
  const [a, b] = values;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return privateIpv4(normalized);
  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? privateIpv4(mapped) : false;
  }
  return true;
}

export async function assertPublicUrl(value, { httpsOnly = false, lookupImpl = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditError("UNSAFE_URL", "URL is invalid.");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || (httpsOnly && url.protocol !== "https:")) {
    throw new AuditError("UNSAFE_URL", httpsOnly ? "Only public HTTPS URLs are supported." : "Only public HTTP(S) URLs are supported.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new AuditError("UNSAFE_URL", "Local and private-network URLs are not supported.");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookupImpl(hostname, { all: true, verbatim: true }).catch(() => {
        throw new AuditError("HOST_UNRESOLVED", "Public hostname could not be resolved.");
      });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AuditError("UNSAFE_URL", "Local and private-network URLs are not supported.");
  }
  return url;
}

export function canonicalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

export async function safeFetch(value, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? dnsLookup;
  const maximumBytes = options.maximumBytes ?? LIMITS.responseBytes;
  const allowedHosts = options.allowedHosts ? new Set(options.allowedHosts.map((host) => String(host).toLowerCase())) : null;
  let current = await assertPublicUrl(value, { httpsOnly: options.httpsOnly ?? true, lookupImpl });
  if (allowedHosts && !allowedHosts.has(current.hostname.toLowerCase())) {
    throw new AuditError("OFF_HOST_REDIRECT", "Public URL was outside the allowed host boundary.");
  }
  for (let redirects = 0; redirects <= LIMITS.redirects; redirects += 1) {
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      response = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": USER_AGENT, accept: options.accept ?? "*/*", ...(options.headers ?? {}) }
      });
    } catch (error) {
      if (error instanceof AuditError) throw error;
      throw new AuditError("FETCH_FAILED", "Public URL could not be fetched.");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === LIMITS.redirects) throw new AuditError("REDIRECT_LIMIT", "Public URL exceeded the safe redirect limit.");
      current = await assertPublicUrl(new URL(location, current).href, { httpsOnly: options.httpsOnly ?? true, lookupImpl });
      if (allowedHosts && !allowedHosts.has(current.hostname.toLowerCase())) {
        throw new AuditError("OFF_HOST_REDIRECT", "Public URL redirected outside the allowed host boundary.");
      }
      continue;
    }
    if (!response.ok) throw new AuditError("HTTP_ERROR", `Public URL returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new AuditError("RESPONSE_TOO_LARGE", "Public response exceeds the processing limit.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maximumBytes) throw new AuditError("RESPONSE_TOO_LARGE", "Public response exceeds the processing limit.");
    return {
      buffer,
      url: current.href,
      mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? ""
    };
  }
  throw new AuditError("FETCH_FAILED", "Public URL could not be fetched.");
}

function robotsPattern(value) {
  const escaped = value.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}${value.endsWith("$") ? "" : ".*"}`.replace("$.*", "$"));
}

export function parseRobots(text, userAgent = USER_AGENT) {
  const sitemapUrls = [];
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === "sitemap" && value) sitemapUrls.push(value);
    else if (key === "user-agent") {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && agents.length && value) {
      rules.push({ type: key, value, pattern: robotsPattern(value) });
    }
  }
  flush();
  const normalizedAgent = userAgent.toLowerCase();
  const exact = groups.filter((group) => group.agents.some((agent) => agent !== "*" && normalizedAgent.includes(agent)));
  const selected = exact.length ? exact : groups.filter((group) => group.agents.includes("*"));
  const selectedRules = selected.flatMap((group) => group.rules);
  return {
    sitemapUrls,
    isAllowed(value) {
      const url = new URL(value);
      const target = `${url.pathname}${url.search}`;
      const matches = selectedRules.filter((rule) => rule.pattern.test(target)).sort((a, b) => b.value.length - a.value.length || (a.type === "allow" ? -1 : 1));
      return !matches.length || matches[0].type === "allow";
    }
  };
}
