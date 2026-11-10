import type { LookupOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Unattended web_fetch may read internal documentation, so RFC1918 stays open.
 * It must not reach the local machine or cloud metadata:
 * loopback (127.0.0.0/8, ::1, and the name localhost), the unspecified range
 * (0.0.0.0/8 and ::), and link-local (169.254.0.0/16, including 169.254.169.254,
 * and IPv6 fe80::/10). IPv4-mapped IPv6 is checked as IPv6 so it follows the
 * same IPv4 rules. BlockList only applies those rules when the family is passed
 * explicitly.
 */
const BLOCKED_UNATTENDED_ADDRESSES = new BlockList();
BLOCKED_UNATTENDED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_UNATTENDED_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_UNATTENDED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_UNATTENDED_ADDRESSES.addAddress("::", "ipv6");
BLOCKED_UNATTENDED_ADDRESSES.addAddress("::1", "ipv6");
BLOCKED_UNATTENDED_ADDRESSES.addSubnet("fe80::", 10, "ipv6");

export const UNATTENDED_BLOCKED_FETCH_REASON =
	"Unattended web_fetch cannot reach loopback, unspecified, or link-local addresses";

export interface ResolvedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export function normalizeUnattendedHost(host: string): string {
	let value = host.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	const zone = value.indexOf("%");
	if (zone !== -1) value = value.slice(0, zone);
	return value.replace(/\.+$/u, "");
}

export function isBlockedUnattendedHost(host: string): boolean {
	const normalized = normalizeUnattendedHost(host);
	if (normalized === "localhost") return true;
	const family = isIP(normalized);
	if (family !== 4 && family !== 6) return false;
	return BLOCKED_UNATTENDED_ADDRESSES.check(normalized, family === 6 ? "ipv6" : "ipv4");
}

/** IP literal in canonical form, or undefined when `host` is a DNS name. */
export function unattendedLiteralAddress(host: string): ResolvedAddress | undefined {
	const normalized = normalizeUnattendedHost(host);
	const family = isIP(normalized);
	if (family !== 4 && family !== 6) return undefined;
	return { address: normalized, family };
}

function addressFamily(family: LookupOptions["family"]): 4 | 6 | undefined {
	if (family === 4 || family === "IPv4") return 4;
	if (family === 6 || family === "IPv6") return 6;
	return undefined;
}

function lookupError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

/**
 * DNS lookup that can only return addresses already accepted for this host.
 * A later resolver change cannot redirect the connection.
 */
export function createUnattendedPinnedLookup(hostname: string, records: readonly ResolvedAddress[]): LookupFunction {
	const expected = normalizeUnattendedHost(hostname);
	return (host, options, callback) => {
		if (normalizeUnattendedHost(host) !== expected) {
			callback(lookupError("ENOTFOUND"), "");
			return;
		}
		const family = addressFamily(options.family);
		const selected = family === undefined ? records : records.filter((record) => record.family === family);
		const first = selected[0];
		if (!first) {
			callback(lookupError("ENOTFOUND"), "");
			return;
		}
		if (options.all) {
			callback(
				null,
				selected.map((record) => ({ address: record.address, family: record.family })),
			);
			return;
		}
		callback(null, first.address, first.family);
	};
}
