/**
 * SSRF guard for custom-command fetch URLs: refuses loopback, private,
 * link-local and other internal addresses, both as literal hosts and as the
 * addresses a hostname resolves to when the request connects.
 */

import * as dns from 'dns';
import * as net from 'net';

export const INTERNAL_URL_ERROR = 'Internal URLs are not allowed';

/** Address ranges a custom command must never reach */
const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata)
  ['172.16.0.0', 12],    // RFC 1918
  ['192.168.0.0', 16],   // RFC 1918
  ['224.0.0.0', 3]       // multicast, reserved and broadcast
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8]          // multicast
] as const) {
  BLOCKED.addSubnet(prefix, bits, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1), else null */
function mappedIPv4(address: string): string | null {
  const match = /^::ffff:(.+)$/i.exec(address);
  if (!match) return null;
  if (net.isIPv4(match[1])) return match[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(match[1]);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** True if `address` (an IP literal) is internal. Non-IP strings return false. */
export function isInternalAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    return v4 ? BLOCKED.check(v4, 'ipv4') : BLOCKED.check(ip, 'ipv6');
  }
  return false;
}

/**
 * Check a URL before fetching: only http(s), and no literal internal host.
 * Hostnames are checked when they resolve (see guardedLookup).
 * @returns an error message, or null when the URL may be fetched
 */
export function checkFetchUrl(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http(s) URLs are allowed';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isInternalAddress(host)) return INTERNAL_URL_ERROR;
  return null;
}

/** A resolved address, in the shape axios' `lookup` option takes */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
type LookupCallback = (err: Error | null, addresses: ResolvedAddress[]) => void;
type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

/**
 * Build a dns.lookup-compatible function for axios' `lookup` option that fails when
 * any resolved address is internal. Checking at connect time (rather than resolving
 * once up front) also covers redirects and DNS answers that change between calls.
 */
export function createGuardedLookup(
  // Looked up on each call, so dns.lookup can be stubbed after this module loads
  resolve: Resolver = (hostname, options, callback) => dns.lookup(hostname, options, callback)
) {
  return (hostname: string, options: object, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      if (addresses.some(a => isInternalAddress(a.address))) {
        return callback(Object.assign(new Error(INTERNAL_URL_ERROR), { code: 'EINTERNALURL' }), []);
      }
      callback(null, addresses.map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  };
}

/** Axios redirect hook: a redirect to a literal internal IP never reaches the lookup, so refuse it here */
export function refuseInternalRedirect(options: { hostname?: string; host?: string }): void {
  const host = options.hostname || options.host || '';
  if (isInternalAddress(host) || /^localhost\.?$/i.test(host)) throw new Error(INTERNAL_URL_ERROR);
}
