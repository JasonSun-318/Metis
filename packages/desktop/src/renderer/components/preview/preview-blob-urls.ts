const BLOB_URL = /^blob:/u;

async function blobUrlToDataUrl(url: string): Promise<string | undefined> {
	if (!BLOB_URL.test(url)) return undefined;
	try {
		const blob = await (await fetch(url)).blob();
		return await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
	} catch {
		return undefined;
	}
}

export async function materializePreviewBlobUrls(root: ParentNode): Promise<void> {
	const cache = new Map<string, string>();
	const resolve = async (url: string): Promise<string | undefined> => {
		const cached = cache.get(url);
		if (cached) return cached;
		const dataUrl = await blobUrlToDataUrl(url);
		if (dataUrl) cache.set(url, dataUrl);
		return dataUrl;
	};

	for (const img of Array.from(root.querySelectorAll("img"))) {
		const next = await resolve(img.currentSrc || img.src);
		if (next) img.src = next;
	}
	for (const image of Array.from(root.querySelectorAll("image"))) {
		for (const attr of ["href", "xlink:href"] as const) {
			const value = image.getAttribute(attr);
			if (!value) continue;
			const next = await resolve(value);
			if (next) image.setAttribute(attr, next);
		}
	}
	for (const element of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
		const background = element.style.backgroundImage;
		const match = /url\("?(blob:[^")]+)"?\)/u.exec(background);
		if (!match) continue;
		const next = await resolve(match[1]!);
		if (next) element.style.backgroundImage = background.replace(match[1]!, next);
	}
}
