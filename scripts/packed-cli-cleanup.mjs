import { rm } from 'node:fs/promises';

export class PackedCliError extends Error {
	constructor(code, message, stage = {}) {
		super(message);
		this.name = 'PackedCliError';
		this.code = code;
		this.packSucceeded = stage.packSucceeded === true;
		this.installSucceeded = stage.installSucceeded === true;
	}
}

export function appendCleanupDiagnostics(primary, cleanupErrors) {
	if (cleanupErrors.length === 0) return primary;
	const diagnostics = cleanupErrors.map((error) => String(error)).join(' | ');
	primary.message = `${primary.message}; cleanup failures: ${diagnostics}`;
	return primary;
}

export async function removeTemporaryRoots(roots) {
	const settled = await Promise.allSettled(
		roots.map((root) => rm(root, { recursive: true, force: true }))
	);
	return settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}
