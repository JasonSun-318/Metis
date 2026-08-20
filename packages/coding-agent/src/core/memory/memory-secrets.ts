/**
 * Heuristic filter for secret-like strings that must not be stored as memory facts.
 */
export function looksLikeSecret(text: string): boolean {
	if (/\bsk-[A-Za-z0-9._-]{3,}/.test(text)) return true;
	if (/\bAKIA[A-Z0-9]{8,}\b/.test(text)) return true;
	if (/-----BEGIN(?:\s+[A-Z0-9]+)+-----/.test(text)) return true;
	if (/\bapi[_-]?key\s*=/i.test(text)) return true;
	// .env-style assignment lines (KEY=value)
	if (/(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/.test(text)) return true;
	return false;
}
