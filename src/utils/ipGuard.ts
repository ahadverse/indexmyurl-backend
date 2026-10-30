import net from 'net';

/**
 * Addresses a server-side URL fetch must never connect to: loopback, private,
 * link-local (incl. the 169.254.169.254 cloud metadata endpoint), CGNAT, multicast,
 * reserved and documentation ranges. net.BlockList also matches IPv4-mapped IPv6
 * (::ffff:127.0.0.1) against the IPv4 rules.
 */
const nonPublic = new net.BlockList();

const IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

for (const [net4, prefix] of IPV4) nonPublic.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of IPV6) nonPublic.addSubnet(net6, prefix, 'ipv6');

/** True only for a syntactically valid IP that is a public, routable address. */
export function isPublicIp(ip: string): boolean {
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!family) return false; // includes zone-id forms like fe80::1%eth0
  return !nonPublic.check(ip, family);
}

/** Hostname as it appears in a URL, without the [] around an IPv6 literal. */
export function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}
