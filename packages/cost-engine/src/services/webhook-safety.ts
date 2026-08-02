// SSRF guard for customer-supplied webhook URLs (ELEAA-781 / P0-7).
//
// Alert/incident/approval destinations are user-controlled strings that we make
// server-side POSTs to. Without a guard, a customer (or an attacker who lands a
// stored config) can point us at the cloud metadata endpoint or an internal
// service and use our egress as an SSRF pivot. This module rejects URLs whose
// host is a loopback / link-local / private / metadata address, and any
// non-http(s) scheme.
//
// Loopback (127.0.0.0/8, ::1, localhost) is a special case: it's the shape a
// local test receiver or a self-hosted on-box collector uses. It is blocked by
// default, but a deployment can opt in via STEADIO_ALLOW_LOOPBACK_WEBHOOKS. The
// metadata endpoint and private/link-local ranges are ALWAYS blocked — the
// opt-in only ever relaxes loopback, never those.
//
// Scope note: this pass validates the URL *host as written* (literal IPs +
// well-known local hostnames). It does NOT resolve DNS, so a public hostname
// that resolves to a private IP at request time (DNS rebinding) is out of scope
// — tracked separately. Validation is synchronous so it can run inside a Zod
// refine and at send time.

export interface SafeUrlOptions {
  // Permit loopback targets (127/8, ::1, localhost). Metadata/private ranges
  // remain blocked regardless.
  allowLoopback?: boolean;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

// True for any private/link-local/unspecified/loopback IPv4. `loopback` out-param
// tells the caller whether the reason was loopback specifically.
function classifyIpv4(host: string): { blocked: boolean; loopback: boolean } {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return { blocked: false, loopback: false };
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return { blocked: false, loopback: false };
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return { blocked: true, loopback: true }; // loopback
  if (a === 0) return { blocked: true, loopback: false }; // 0.0.0.0/8 "this host"
  if (a === 10) return { blocked: true, loopback: false }; // 10/8 private
  if (a === 169 && b === 254) return { blocked: true, loopback: false }; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, loopback: false }; // 172.16/12
  if (a === 192 && b === 168) return { blocked: true, loopback: false }; // 192.168/16
  return { blocked: false, loopback: false };
}

// An IPv4-mapped IPv6 tail (after "::ffff:") may be dotted (a.b.c.d) or, as Node's
// URL normalizes it, two hex groups (e.g. 127.0.0.1 -> "7f00:1"). Return the
// dotted IPv4 string, or null if it isn't a well-formed mapped address.
function mappedTailToIpv4(tail: string): string | null {
  if (tail.includes(".")) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(tail) ? tail : null;
  }
  const groups = tail.split(":");
  if (groups.length !== 2) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const [hi, lo] = nums as [number, number];
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// Classify an IP host. { blocked, loopback } as above; { blocked:false } for a
// public IP or a non-IP hostname.
function classifyIp(rawHost: string): { blocked: boolean; loopback: boolean } {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1") return { blocked: true, loopback: true }; // IPv6 loopback
  if (host === "::") return { blocked: true, loopback: false }; // unspecified
  if (host.includes(":")) {
    if (/^fe[89ab]/.test(host)) return { blocked: true, loopback: false }; // fe80::/10 link-local
    if (host.startsWith("fc") || host.startsWith("fd")) return { blocked: true, loopback: false }; // fc00::/7
    if (host.startsWith("::ffff:")) {
      const v4 = mappedTailToIpv4(host.slice("::ffff:".length));
      if (v4) return classifyIpv4(v4);
    }
    return { blocked: false, loopback: false };
  }
  return classifyIpv4(host);
}

/**
 * True when `raw` is a well-formed http(s) URL whose host is a target we are
 * allowed to POST to. Loopback / link-local / private / metadata hosts and
 * non-http(s) schemes return false. Loopback is permitted only when
 * `opts.allowLoopback` is set.
 */
export function isSafeWebhookUrl(raw: string, opts: SafeUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;

  // Loopback hostnames — allowed only under the opt-in.
  if (LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    return opts.allowLoopback === true;
  }
  // mDNS / private-domain suffix — always blocked (not a loopback receiver).
  if (host.endsWith(".local")) return false;

  const { blocked, loopback } = classifyIp(host);
  if (!blocked) return true;
  // Blocked address: relax ONLY loopback under the opt-in.
  return loopback && opts.allowLoopback === true;
}

export class UnsafeWebhookUrlError extends Error {
  constructor(url: string) {
    super(
      `Refusing to send to unsafe webhook URL (private/loopback/metadata host or non-http(s) scheme): ${url}`,
    );
    this.name = "UnsafeWebhookUrlError";
  }
}

// A deployment can opt into loopback webhook targets (local receivers / on-box
// collectors). Off by default — least privilege.
function loopbackAllowedByEnv(): boolean {
  const v = process.env["STEADIO_ALLOW_LOOPBACK_WEBHOOKS"];
  return v === "1" || v === "true";
}

/**
 * Send-time defense-in-depth: throw if a stored/incoming webhook URL is unsafe.
 * Honors STEADIO_ALLOW_LOOPBACK_WEBHOOKS for loopback targets. Callers already
 * run under Promise.allSettled / try-catch, so the throw is swallowed like any
 * other delivery failure.
 */
export function assertSafeWebhookUrl(url: string): void {
  if (!isSafeWebhookUrl(url, { allowLoopback: loopbackAllowedByEnv() })) {
    throw new UnsafeWebhookUrlError(url);
  }
}
