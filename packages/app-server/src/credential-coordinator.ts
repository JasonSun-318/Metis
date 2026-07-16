import { join } from "node:path";
import { type AuthStatus, AuthStorage, FileAuthStorageBackend } from "@arcmind/coding-agent";

export interface CredentialCoordinatorOptions {
	readonly agentDir: string;
}

/** One credential backend with weakly-held, session-local auth views. */
export class CredentialCoordinator {
	private readonly backend: FileAuthStorageBackend;
	private readonly views = new Set<WeakRef<AuthStorage>>();

	constructor(options: CredentialCoordinatorOptions) {
		this.backend = new FileAuthStorageBackend(join(options.agentDir, "auth.json"));
	}

	createView(): AuthStorage {
		const view = AuthStorage.fromStorage(this.backend, () => this.reloadViews());
		this.views.add(new WeakRef(view));
		return view;
	}

	getStatus(view: AuthStorage, provider: string): AuthStatus {
		return view.getAuthStatus(provider);
	}

	private reloadViews(): void {
		for (const reference of this.views) {
			const view = reference.deref();
			if (view) view.reload();
			else this.views.delete(reference);
		}
	}
}
