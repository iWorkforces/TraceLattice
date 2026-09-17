import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySuspensionStore } from '../../../core/tools/InMemorySuspensionStore.js';
import { asSessionId, asThoughtId } from '../../../contracts/ids.js';
import type { SuspensionRecord } from '../../../contracts/suspension.js';
import { SuspensionExpiredError, SuspensionNotFoundError } from '../../../errors.js';

describe('InMemorySuspensionStore', () => {
	let store: InMemorySuspensionStore;
	type SuspensionInput = Omit<SuspensionRecord, 'token' | 'createdAt' | 'toolCallThoughtId'> & {
		ttlMs?: number;
	};
	const suspend = (record: SuspensionInput): SuspensionRecord =>
		store.suspend({
			...record,
			toolCallThoughtId: asThoughtId(`call-${record.toolCallThoughtNumber}`),
		});

	beforeEach(() => {
		store = new InMemorySuspensionStore({ ttlMs: 60_000, sweepIntervalMs: 60_000 });
	});

	afterEach(() => {
		store.stop();
		vi.useRealTimers();
	});

	it('suspend() returns a fully populated record with token, createdAt, and expiresAt', () => {
		const before = Date.now();
		const rec = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 3,
			toolName: 'search',
			toolArguments: { q: 'foo' },
			expiresAt: 0,
		});
		expect(typeof rec.token).toBe('string');
		expect(rec.token.length).toBeGreaterThan(0);
		expect(rec.sessionId).toBe('s1');
		expect(rec.toolCallThoughtNumber).toBe(3);
		expect(rec.toolName).toBe('search');
		expect(rec.toolArguments).toEqual({ q: 'foo' });
		expect(rec.createdAt).toBeGreaterThanOrEqual(before);
		expect(rec.expiresAt).toBeGreaterThan(rec.createdAt);
		expect(rec.expiresAt - rec.createdAt).toBe(60_000);
	});

	it('suspend() with explicit ttlMs overrides the default', () => {
		const rec = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			ttlMs: 5_000,
			expiresAt: 0,
		});
		expect(rec.expiresAt - rec.createdAt).toBe(5_000);
	});

	it('resume() returns the record once and removes it (single-use)', () => {
		const rec = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		const first = store.resume(rec.token);
		expect(first).not.toBeNull();
		expect(first?.token).toBe(rec.token);
		const second = store.resume(rec.token);
		expect(second).toBeNull();
	});

	it('resume() returns null and deletes the record when expired', () => {
		const rec = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			ttlMs: 1,
			expiresAt: 0,
		});
		const realNow = Date.now();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10_000);
		try {
			expect(store.resume(rec.token)).toBeNull();
			// After expired resume, record is gone; subsequent peek returns null too.
			expect(store.peek(rec.token)).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it('peek() is non-destructive and returns expired records as-is', () => {
		const rec = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			ttlMs: 1,
			expiresAt: 0,
		});
		const realNow = Date.now();
		const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10_000);
		try {
			const peeked = store.peek(rec.token);
			expect(peeked).not.toBeNull();
			expect(peeked?.token).toBe(rec.token);
			// Peek again — still present (not consumed).
			expect(store.peek(rec.token)).not.toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it('peek() returns null for unknown tokens', () => {
		expect(store.peek('nonexistent-token')).toBeNull();
	});

	it('expireOlderThan() removes expired records and returns the count', () => {
		const r1 = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			ttlMs: 1,
			expiresAt: 0,
		});
		const r2 = suspend({
			sessionId: asSessionId('s1'),
			toolCallThoughtNumber: 2,
			toolName: 't',
			toolArguments: {},
			ttlMs: 60_000,
			expiresAt: 0,
		});
		const removed = store.expireOlderThan(Date.now() + 10_000);
		// r1 expired, r2 still valid relative to (now+10s) since ttl=60s
		expect(removed).toBe(1);
		expect(store.peek(r1.token)).toBeNull();
		expect(store.peek(r2.token)).not.toBeNull();
	});

	it('clearSession() removes only the targeted session', () => {
		suspend({
			sessionId: asSessionId('sA'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		suspend({
			sessionId: asSessionId('sA'),
			toolCallThoughtNumber: 2,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		suspend({
			sessionId: asSessionId('sB'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		expect(store.size('sA')).toBe(2);
		expect(store.size('sB')).toBe(1);
		store.clearSession('sA');
		expect(store.size('sA')).toBe(0);
		expect(store.size('sB')).toBe(1);
	});

	it('size() returns global total when no session id is provided, and per-session count otherwise', () => {
		expect(store.size()).toBe(0);
		suspend({
			sessionId: asSessionId('sA'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		suspend({
			sessionId: asSessionId('sB'),
			toolCallThoughtNumber: 1,
			toolName: 't',
			toolArguments: {},
			expiresAt: 0,
		});
		expect(store.size()).toBe(2);
		expect(store.size('sA')).toBe(1);
		expect(store.size('sB')).toBe(1);
		expect(store.size('unknown')).toBe(0);
	});

	it('start() and stop() are idempotent', () => {
		expect(() => {
			store.start();
			store.start();
			store.stop();
			store.stop();
		}).not.toThrow();
	});

	it('compareAndAdmit rejects a wrong canonical session without consuming the token', async () => {
		const record = suspend({
			sessionId: asSessionId('session-a'),
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const admit = vi.fn();

		await expect(
			store.compareAndAdmit(record.token, asSessionId('session-b'), admit)
		).rejects.toBeInstanceOf(SuspensionNotFoundError);

		expect(admit).not.toHaveBeenCalled();
		expect(store.peek(record.token)).toBe(record);
	});

	it('compareAndAdmit expires at equality and classifies the next attempt as missing', async () => {
		vi.useFakeTimers({ now: new Date('2026-09-15T00:00:00.000Z') });
		const record = suspend({
			sessionId: asSessionId('session-a'),
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			ttlMs: 100,
			expiresAt: 0,
		});
		const admit = vi.fn();
		vi.setSystemTime(record.expiresAt);

		await expect(
			store.compareAndAdmit(record.token, record.sessionId, admit)
		).rejects.toBeInstanceOf(SuspensionExpiredError);
		await expect(
			store.compareAndAdmit(record.token, record.sessionId, admit)
		).rejects.toBeInstanceOf(SuspensionNotFoundError);

		expect(admit).not.toHaveBeenCalled();
		expect(store.size(record.sessionId)).toBe(0);
	});

	it('compareAndAdmit gives concurrent duplicate attempts exactly one winner', async () => {
		const record = suspend({
			sessionId: asSessionId('session-a'),
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const admit = vi.fn();

		const results = await Promise.allSettled([
			store.compareAndAdmit(record.token, record.sessionId, admit),
			store.compareAndAdmit(record.token, record.sessionId, admit),
		]);

		expect(admit).toHaveBeenCalledOnce();
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({ reason: expect.any(SuspensionNotFoundError) });
		expect(store.size()).toBe(0);
	});

	it('compareAndAdmit retains the token after callback failure and permits one retry', async () => {
		const record = suspend({
			sessionId: asSessionId('session-a'),
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const sentinel = new TypeError('controlled admission failure');
		const failedAdmit = vi.fn(() => {
			throw sentinel;
		});

		await expect(store.compareAndAdmit(record.token, record.sessionId, failedAdmit)).rejects.toBe(
			sentinel
		);
		expect(store.peek(record.token)).toBe(record);

		const retryAdmit = vi.fn();
		await expect(store.compareAndAdmit(record.token, record.sessionId, retryAdmit)).resolves.toBe(
			record
		);
		expect(retryAdmit).toHaveBeenCalledOnce();
		await expect(
			store.compareAndAdmit(record.token, record.sessionId, retryAdmit)
		).rejects.toBeInstanceOf(SuspensionNotFoundError);
	});

	it('compareAndAdmit does not await a callback promise or share its queue with another token', async () => {
		const sessionId = asSessionId('session-a');
		const recordA = suspend({
			sessionId,
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const recordB = suspend({
			sessionId,
			toolCallThoughtNumber: 2,
			toolName: 'fetch',
			toolArguments: {},
			expiresAt: 0,
		});
		const callbackGate = Promise.withResolvers<void>();

		const first = store.compareAndAdmit(recordA.token, sessionId, () => callbackGate.promise);
		const second = store.compareAndAdmit(recordB.token, sessionId, () => undefined);

		await expect(second).resolves.toBe(recordB);
		await expect(first).resolves.toBe(recordA);
		callbackGate.resolve();
	});

	it('clearSession removes a queued token before admission and active cleanup cannot resurrect it', async () => {
		const sessionId = asSessionId('session-a');
		const queued = suspend({
			sessionId,
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const queuedAdmit = vi.fn();
		const queuedAdmission = store.compareAndAdmit(queued.token, sessionId, queuedAdmit);
		store.clearSession(sessionId);

		await expect(queuedAdmission).rejects.toBeInstanceOf(SuspensionNotFoundError);
		expect(queuedAdmit).not.toHaveBeenCalled();

		const active = suspend({
			sessionId,
			toolCallThoughtNumber: 2,
			toolName: 'fetch',
			toolArguments: {},
			expiresAt: 0,
		});
		await store.compareAndAdmit(active.token, sessionId, () => store.clearSession(sessionId));
		expect(store.size(sessionId)).toBe(0);
	});

	it('clearAll removes every queued token before any callback can admit', async () => {
		const recordA = suspend({
			sessionId: asSessionId('session-a'),
			toolCallThoughtNumber: 1,
			toolName: 'search',
			toolArguments: {},
			expiresAt: 0,
		});
		const recordB = suspend({
			sessionId: asSessionId('session-b'),
			toolCallThoughtNumber: 1,
			toolName: 'fetch',
			toolArguments: {},
			expiresAt: 0,
		});
		const admit = vi.fn();
		const admissions = [
			store.compareAndAdmit(recordA.token, recordA.sessionId, admit),
			store.compareAndAdmit(recordB.token, recordB.sessionId, admit),
		];
		store.clearAll();

		const results = await Promise.allSettled(admissions);
		expect(results).toEqual([
			expect.objectContaining({ status: 'rejected' }),
			expect.objectContaining({ status: 'rejected' }),
		]);
		expect(admit).not.toHaveBeenCalled();
		expect(store.size()).toBe(0);
	});
});
