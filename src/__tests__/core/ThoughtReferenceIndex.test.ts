import { describe, expect, it } from 'vitest';

import { asSessionId, asThoughtId } from '../../contracts/ids.js';
import { ThoughtReferenceIndex } from '../../core/ThoughtReferenceIndex.js';
import { createTestThought } from '../helpers/factories.js';

const SESSION = asSessionId('indexed');

describe('ThoughtReferenceIndex', () => {
	it('ref-counts repeated stable ids and removes identity only at zero', () => {
		const index = new ThoughtReferenceIndex();
		const thought = createTestThought({ id: 'same', thought_number: 5 });
		index.add(SESSION, thought);
		index.add(SESSION, thought);

		index.remove(SESSION, thought);
		expect(index.resolve(SESSION, 5)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('same'),
		});
		index.remove(SESSION, thought);
		expect(index.resolve(SESSION, 5)).toEqual({ kind: 'missing' });
	});

	it('removing an unknown record leaves existing resolution unchanged', () => {
		const index = new ThoughtReferenceIndex();
		index.add(SESSION, createTestThought({ id: 'kept', thought_number: 2 }));

		index.remove(SESSION, createTestThought({ id: 'unknown', thought_number: 2 }));
		expect(index.resolve(SESSION, 2)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('kept'),
		});
	});

	it('replaceSession discards stale buckets and skips idless records', () => {
		const index = new ThoughtReferenceIndex();
		index.add(SESSION, createTestThought({ id: 'stale', thought_number: 1 }));
		const idless = createTestThought({ thought_number: 8 });
		delete idless.id;

		index.replaceSession(SESSION, [idless, createTestThought({ id: 'fresh', thought_number: 9 })]);
		expect(index.resolve(SESSION, 1)).toEqual({ kind: 'missing' });
		expect(index.resolve(SESSION, 8)).toEqual({ kind: 'missing' });
		expect(index.resolve(SESSION, 9)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('fresh'),
		});
	});

	it('keeps the prior session index when replacement iteration fails', () => {
		const index = new ThoughtReferenceIndex();
		index.add(SESSION, createTestThought({ id: 'prior', thought_number: 3 }));
		function* failingReplacement() {
			yield createTestThought({ id: 'partial', thought_number: 4 });
			throw new Error('controlled iteration failure');
		}

		expect(() => index.replaceSession(SESSION, failingReplacement())).toThrow(
			'controlled iteration failure'
		);
		expect(index.resolve(SESSION, 3)).toEqual({
			kind: 'unique',
			thoughtId: asThoughtId('prior'),
		});
		expect(index.resolve(SESSION, 4)).toEqual({ kind: 'missing' });
	});

	it('clearSession preserves other session buckets', () => {
		const index = new ThoughtReferenceIndex();
		const other = asSessionId('other');
		index.add(SESSION, createTestThought({ id: 'one', thought_number: 1 }));
		index.add(other, createTestThought({ id: 'two', thought_number: 1 }));

		index.clearSession(SESSION);
		expect(index.resolve(SESSION, 1)).toEqual({ kind: 'missing' });
		expect(index.resolve(other, 1).kind).toBe('unique');
	});

	it('clearAll removes every session bucket', () => {
		const index = new ThoughtReferenceIndex();
		const other = asSessionId('other');
		index.add(SESSION, createTestThought({ id: 'one', thought_number: 1 }));
		index.add(other, createTestThought({ id: 'two', thought_number: 2 }));

		index.clearAll();
		expect(index.resolve(SESSION, 1)).toEqual({ kind: 'missing' });
		expect(index.resolve(other, 2)).toEqual({ kind: 'missing' });
	});
});
