/**
 * The capability resolver — PURE (portability wave, 2026-11-03).
 *
 * Given a chain, the provider declarations, and a presence-only picture of
 * the environment, decide which provider is live for one capability. No IO,
 * no env reads, no network: everything it needs is passed in, which is what
 * makes the switching rules testable without a model, a key, or a browser.
 *
 * The rules (see types.ts for the origin):
 *   1. Walk the chain in order; the first provider whose requirements are
 *      met becomes active.
 *   2. Report every provider tried, with the reason it did not resolve.
 *   3. If none resolve, the capability is honestly unavailable — never a
 *      silent downgrade.
 */

import type {
	CapabilityConfig,
	CapabilityState,
	CheckedProvider,
	ProviderDeclaration,
	ProviderRequirements,
	ProviderStatus,
	ResolverEnvironment,
} from "./types.ts";

/** Why a provider cannot be live right now, or `null` when it can. */
export function unmetRequirement(
	requires: ProviderRequirements | undefined,
	env: ResolverEnvironment,
	providerId: string,
): string | null {
	if (!requires) return null;

	for (const name of requires.env ?? []) {
		const value = env.env[name];
		if (value === undefined || value.trim() === "") {
			return `no ${name}`;
		}
	}

	if (requires.switch) {
		const value = env.env[requires.switch.name]?.trim().toLowerCase();
		if (value !== requires.switch.value) return `set ${requires.switch.name}=${requires.switch.value}`;
	}

	if (requires.endpoint && !(env.endpointsUp ?? []).includes(providerId)) {
		return "endpoint not configured";
	}

	if (requires.binary && !(env.binaries ?? []).includes(requires.binary)) {
		return `${requires.binary} not installed`;
	}

	if (requires.appGate && !(env.gatesPassed ?? []).includes(providerId)) {
		return "not connected (no key or subscription)";
	}

	if (requires.secureContext && !env.secureContext) {
		return "needs https or localhost";
	}

	return null;
}

/** The status of one provider, derived from presence alone. */
export function probeProvider(
	declaration: ProviderDeclaration,
	env: ResolverEnvironment,
): ProviderStatus {
	if (declaration.pending) {
		return { available: false, reason: `${declaration.label}: adapter not built yet` };
	}
	const missing = unmetRequirement(declaration.requires, env, declaration.id);
	if (missing) {
		return { available: false, reason: `${declaration.label}: ${missing}` };
	}
	return { available: true, reason: `${declaration.label} ready` };
}

/**
 * Resolve one capability. `declarations` is the provider catalog; unknown
 * provider ids in a chain are reported as such rather than crashing the app
 * (a typo in config must not take the server down).
 */
export function resolveCapability(
	kind: CapabilityState["kind"],
	config: CapabilityConfig | undefined,
	declarations: Record<string, ProviderDeclaration>,
	env: ResolverEnvironment,
): CapabilityState {
	const chain = config?.chain ?? [];
	const checked: CheckedProvider[] = [];

	for (let index = 0; index < chain.length; index++) {
		const entry = chain[index]!;
		const declaration = declarations[entry.provider];

		if (!declaration) {
			checked.push({
				provider: entry.provider,
				status: { available: false, reason: `unknown provider "${entry.provider}"` },
			});
			continue;
		}

		const status = probeProvider(declaration, env);
		checked.push({ provider: entry.provider, status });
		if (!status.available) continue;

		return {
			kind,
			active: entry.provider,
			status,
			checked,
			fallbackUsed: index > 0,
		};
	}

	const reason =
		chain.length === 0
			? "no provider configured"
			: `none available (${checked.map((c) => c.provider).join(", ")} all unmet)`;

	return {
		kind,
		active: null,
		status: { available: false, reason },
		checked,
		fallbackUsed: false,
	};
}
