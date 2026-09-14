import type { PersistenceBackend, PersistenceConfig } from '../contracts/PersistenceBackend.js';

/**
 * Create a persistence backend based on the provided configuration.
 *
 * Uses dynamic imports to avoid loading unused backends,
 * keeping the factory decoupled from concrete implementations.
 *
 * @param config - Persistence configuration
 * @returns A configured persistence backend, or null if disabled
 *
 * @example
 * ```typescript
 * const backend = createPersistenceBackend({
 *   enabled: true,
 *   backend: 'file',
 *   options: { dataDir: './data' }
 * });
 * ```
 */
export async function createPersistenceBackend(
	config: PersistenceConfig
): Promise<PersistenceBackend | null> {
	if (!config.enabled) {
		return null;
	}

	switch (config.backend) {
		case 'file': {
			const { FilePersistence } = await import('./FilePersistence.js');
			return await FilePersistence.create(config.options);
		}

		case 'sqlite': {
			const { SqlitePersistence } = await import('./SqlitePersistence.js');
			return await SqlitePersistence.create(config.options);
		}

		case 'memory': {
			const { MemoryPersistence } = await import('./MemoryPersistence.js');
			return new MemoryPersistence({
				maxHistorySize: config.options?.maxHistorySize,
				persistBranches: config.options?.persistBranches,
			});
		}

		default:
			throw new Error(`Unknown persistence backend: ${config.backend}`);
	}
}
