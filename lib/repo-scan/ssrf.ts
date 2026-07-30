// Pre-clone SSRF guard.
//
// The clone URL is never the string the user submitted: parseGitHubRepoUrl
// rebuilds it from validated `owner`/`repo` segments, so it is always
// literally `https://github.com/<owner>/<repo>.git`. That already removes
// URL-shaped SSRF (no host substitution, no credentials, no port, no
// scheme games).
//
// This file closes the remaining gap: what that fixed hostname *resolves*
// to. A poisoned DNS answer, a hosts-file entry, or a rebinding attack on a
// developer/CI machine could point github.com at 127.0.0.1 or a metadata
// endpoint like 169.254.169.254, and git would happily connect. So before
// any network call we resolve the name ourselves and refuse to proceed
// unless every answer is a public address.

import { lookup } from "node:dns/promises";

const ALLOWED_CLONE_HOSTS = new Set(["github.com", "www.github.com"]);

export class RepoHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoHostError";
  }
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;

  if (a === 0) return false; // 0.0.0.0/8 "this host"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

function ipv6IsPublic(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0]; // drop any zone index

  if (addr === "::" || addr === "::1") return false; // unspecified, loopback
  if (addr.startsWith("fe8") || addr.startsWith("fe9")) return false; // link-local
  if (addr.startsWith("fea") || addr.startsWith("feb")) return false; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return false; // unique-local
  if (addr.startsWith("ff")) return false; // multicast

  // IPv4-mapped/compatible (::ffff:127.0.0.1) — judge the embedded IPv4.
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPublic(mapped[1]);

  return true;
}

/**
 * Exported so the range table can be tested directly — a DNS answer can't be
 * faked from a test, but this classifier is where the actual decision lives.
 */
export function isPublicAddress(address: string, family: number): boolean {
  return family === 4 ? ipv4IsPublic(address) : ipv6IsPublic(address);
}

/**
 * Throws unless `hostname` is a GitHub host that currently resolves to
 * public addresses only. Call this immediately before cloning — never cache
 * the result, since the point is to catch a resolution that has been
 * tampered with for *this* request.
 */
export async function assertResolvesToPublicGitHub(hostname: string): Promise<string[]> {
  const host = hostname.toLowerCase();

  // Defense in depth: parseGitHubRepoUrl already guarantees this, but this
  // function must be safe to call from anywhere, not only behind that check.
  if (!ALLOWED_CLONE_HOSTS.has(host)) {
    throw new RepoHostError(`Refusing to clone from a non-GitHub host: ${hostname}`);
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new RepoHostError(
      "Couldn't resolve github.com from this server — check the network and try again.",
    );
  }

  if (answers.length === 0) {
    throw new RepoHostError("github.com resolved to no addresses — refusing to clone.");
  }

  // Every answer must be public. Rejecting on *any* bad address (rather than
  // requiring one good one) means a poisoned split answer can't slip through
  // by including one legitimate IP alongside 127.0.0.1.
  const offending = answers.filter((a) => !isPublicAddress(a.address, a.family));
  if (offending.length > 0) {
    throw new RepoHostError(
      `github.com resolved to a non-public address (${offending
        .map((a) => a.address)
        .join(", ")}) — refusing to clone. This usually means DNS or /etc/hosts has been tampered with.`,
    );
  }

  return answers.map((a) => a.address);
}
