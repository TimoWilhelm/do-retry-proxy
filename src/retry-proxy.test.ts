import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry } from './retry-proxy';

function createRetryableError(message: string): Error & { retryable: boolean } {
	const error = new Error(message) as Error & { retryable: boolean };
	error.retryable = true;
	return error;
}

function createOverloadedError(message: string): Error & { retryable: boolean; overloaded: boolean } {
	const error = new Error(message) as Error & { retryable: boolean; overloaded: boolean };
	error.retryable = true;
	error.overloaded = true;
	return error;
}

function createNonRetryableError(message: string): Error {
	return new Error(message);
}

// Use minimal delays so tests complete quickly while still exercising real scheduler.wait()
const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 10 };

describe('withRetry', () => {
	let mockMethod: ReturnType<typeof vi.fn>;
	let stubCreationCount: number;

	function createMockNamespace(): DurableObjectNamespace<Rpc.DurableObjectBranded> {
		stubCreationCount = 0;
		mockMethod = vi.fn();

		const createStub = () => {
			stubCreationCount++;
			return {
				id: { toString: () => 'test-id' },
				name: 'test-stub',
				testMethod: mockMethod,
			};
		};

		return {
			get: vi.fn((_id: DurableObjectId) => createStub()),
			getByName: vi.fn((_name: string) => createStub()),
			idFromName: vi.fn((name: string) => ({ toString: () => name })),
			idFromString: vi.fn((id: string) => ({ toString: () => id })),
			newUniqueId: vi.fn(() => ({ toString: () => 'unique-id' })),
			jurisdiction: vi.fn(),
		} as unknown as DurableObjectNamespace<Rpc.DurableObjectBranded>;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('passes through successful calls without retry', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace);
		mockMethod.mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;
		const result = await stub.testMethod('arg1');

		expect(result).toBe('success');
		expect(mockMethod).toHaveBeenCalledTimes(1);
		expect(mockMethod).toHaveBeenCalledWith('arg1');
		expect(stubCreationCount).toBe(1);
	});

	it('retries on retryable errors and succeeds', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);
		mockMethod
			.mockRejectedValueOnce(createRetryableError('transient-1'))
			.mockRejectedValueOnce(createRetryableError('transient-2'))
			.mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;
		const result = await stub.testMethod();

		expect(result).toBe('success');
		expect(mockMethod).toHaveBeenCalledTimes(3);
	});

	it('creates fresh stub on each retry attempt', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);
		mockMethod
			.mockRejectedValueOnce(createRetryableError('transient-1'))
			.mockRejectedValueOnce(createRetryableError('transient-2'))
			.mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;
		await stub.testMethod();

		// Initial stub + 2 retries = 3 stubs created
		expect(stubCreationCount).toBe(3);
	});

	it('does not retry non-retryable errors', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);
		mockMethod.mockRejectedValue(createNonRetryableError('fatal'));

		const stub = wrapped.getByName('test') as any;

		await expect(stub.testMethod()).rejects.toThrow('fatal');
		expect(mockMethod).toHaveBeenCalledTimes(1);
		expect(stubCreationCount).toBe(1);
	});

	it('does not retry overloaded errors', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);
		mockMethod.mockRejectedValue(createOverloadedError('overloaded'));

		const stub = wrapped.getByName('test') as any;

		await expect(stub.testMethod()).rejects.toThrow('overloaded');
		expect(mockMethod).toHaveBeenCalledTimes(1);
		expect(stubCreationCount).toBe(1);
	});

	it('respects maxAttempts limit', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, { maxAttempts: 2, ...FAST_RETRY });
		mockMethod.mockRejectedValue(createRetryableError('always-fails'));

		const stub = wrapped.getByName('test') as any;

		await expect(stub.testMethod()).rejects.toThrow('always-fails');
		expect(mockMethod).toHaveBeenCalledTimes(2);
	});

	it('works with get() method', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);
		mockMethod.mockResolvedValue('success');

		const mockId = { toString: () => 'test-id' } as DurableObjectId;
		const stub = wrapped.get(mockId) as any;
		const result = await stub.testMethod();

		expect(result).toBe('success');
		expect(namespace.get).toHaveBeenCalledWith(mockId);
	});

	it('passes through non-function properties', () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace);

		const stub = wrapped.getByName('test');

		expect(stub.id.toString()).toBe('test-id');
		expect(stub.name).toBe('test-stub');
	});

	it('preserves namespace utility methods', () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace);

		wrapped.idFromName('test-name');
		expect(namespace.idFromName).toHaveBeenCalledWith('test-name');

		wrapped.idFromString('test-id');
		expect(namespace.idFromString).toHaveBeenCalledWith('test-id');

		wrapped.newUniqueId();
		expect(namespace.newUniqueId).toHaveBeenCalled();
	});

	it('supports custom isRetryable function for application errors', async () => {
		const namespace = createMockNamespace();
		const customRetryable = vi.fn().mockReturnValue(true);
		const wrapped = withRetry(namespace, { isRetryable: customRetryable, ...FAST_RETRY });

		// Error that is NOT retryable by infrastructure rules (no .retryable property)
		const error = createNonRetryableError('app-error');
		mockMethod.mockRejectedValueOnce(error).mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;

		const result = await stub.testMethod();
		expect(result).toBe('success');
		expect(customRetryable).toHaveBeenCalledWith(error);
		expect(mockMethod).toHaveBeenCalledTimes(2);
	});

	it('automatically retries infrastructure errors without custom predicate', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, FAST_RETRY);

		mockMethod.mockRejectedValueOnce(createRetryableError('infra-fail')).mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;
		const result = await stub.testMethod();

		expect(result).toBe('success');
		expect(mockMethod).toHaveBeenCalledTimes(2);
	});

	it('retries up to maxAttempts with backoff', async () => {
		const namespace = createMockNamespace();
		const wrapped = withRetry(namespace, { maxAttempts: 4, ...FAST_RETRY });

		mockMethod
			.mockRejectedValueOnce(createRetryableError('fail-1'))
			.mockRejectedValueOnce(createRetryableError('fail-2'))
			.mockRejectedValueOnce(createRetryableError('fail-3'))
			.mockResolvedValue('success');

		const stub = wrapped.getByName('test') as any;
		const result = await stub.testMethod();

		expect(result).toBe('success');
		expect(mockMethod).toHaveBeenCalledTimes(4);
	});
});
