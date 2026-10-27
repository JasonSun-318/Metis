import githubMark from "../assets/github-mark.svg";

// Reicon supplies general UI icons; this is GitHub's official Octicons brand asset.
export function GitHubBrandIcon({ size = 20 }: { readonly size?: number }) {
	return (
		<span
			aria-hidden="true"
			className="github-brand-icon"
			style={{ width: size, height: size, maskImage: `url("${githubMark}")` }}
		/>
	);
}
