/**
 * Transparent retry proxy for Durable Objects.
 *
 * Wraps a DurableObjectNamespace to automatically retry failed RPC calls
 * with exponential backoff and jitter. Creates a fresh stub on each retry
 * since exceptions can leave stubs in a "broken" state.
 *
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */

export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxAttempts?: number;
	/** Base delay in milliseconds for exponential backoff (default: 100) */
	baseDelayMs?: number;
	/** Maximum delay in milliseconds (default: 3000) */
	maxDelayMs?: number;
	/** Custom function to determine if an error is retryable */
	isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'isRetryable'>> = {
	maxAttempts: 3,
	baseDelayMs: 100,
	maxDelayMs: 3000,
};

/**
 * Returns true if the error is retryable according to Durable Object error handling best practices.
 * - `.retryable` must be true
 * - `.overloaded` must NOT be true (retrying would worsen the overload)
 */
function isErrorRetryable(err: unknown): boolean {
	const e = err as Record<string, unknown>;
	const msg = String(err);
	return Boolean(e?.retryable) && !Boolean(e?.overloaded) && !msg.includes('Durable Object is overloaded');
}

/**
 * Calculates jittered exponential backoff delay.
 * Uses the "Full Jitter" approach from AWS.
 * @see https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
function jitterBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	const attemptUpperBoundMs = Math.min(2 ** attempt * baseDelayMs, maxDelayMs);
	return Math.floor(Math.random() * attemptUpperBoundMs);
}

type StubGetter<T extends Rpc.DurableObjectBranded> = () => DurableObjectStub<T>;

/**
 * Creates a proxy around a DurableObjectStub that retries failed RPC calls.
 * On each retry, a fresh stub is obtained via the getter function.
 */
function createStubProxy<T extends Rpc.DurableObjectBranded>(
	getStub: StubGetter<T>,
	options: Required<Omit<RetryOptions, 'isRetryable'>> & { isRetryable?: (err: unknown) => boolean },
): DurableObjectStub<T> {
	const stub = getStub();

	return new Proxy(stub, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, target);

			// Only intercept function calls (RPC methods)
			if (typeof value !== 'function') {
				return value;
			}

			// Don't wrap internal properties
			if (typeof prop === 'symbol') {
				return value;
			}

			return async (...args: unknown[]) => {
				let attempt = 1;
				let lastError: unknown;
				let currentStub = target;

				while (attempt <= options.maxAttempts) {
					try {
						// On the first attempt, we use the initial stub (target).
						// On subsequent attempts, currentStub is updated to a fresh stub.
						return await (currentStub as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
					} catch (err) {
						lastError = err;

						// Check if we should retry
						// 1. Always retry infrastructure errors (unless overloaded)
						if (isErrorRetryable(err)) {
							// continue to retry logic
						}
						// 2. Check custom predicate if provided
						else if (options.isRetryable && options.isRetryable(err)) {
							// continue to retry logic
						} else {
							throw err;
						}

						// Check if we've exhausted attempts
						if (attempt >= options.maxAttempts) {
							break;
						}

						// Always create a fresh stub for the next attempt.
						// Many exceptions leave the stub in a "broken" state.
						// Even for application errors (.remote = true), it is safer and cheap to recreate.
						currentStub = getStub();

						// Calculate backoff and wait
						const delay = jitterBackoff(attempt, options.baseDelayMs, options.maxDelayMs);
						await scheduler.wait(delay);

						attempt++;
					}
				}

				throw lastError;
			};
		},
	});
}

/**
 * Wraps a DurableObjectNamespace with automatic retry capabilities.
 *
 * The returned namespace is fully transparent - use it exactly like the original.
 * All RPC method calls on stubs obtained from this namespace will automatically
 * retry on transient failures with exponential backoff.
 *
 * @example
 * ```ts
 * const namespace = withRetry(ctx.exports.MyDurableObject);
 * const stub = namespace.get(id);
 * const result = await stub.someMethod(); // Automatically retries on failure
 * ```
 */
export function withRetry<T extends Rpc.DurableObjectBranded>(
	namespace: DurableObjectNamespace<T>,
	options?: RetryOptions,
): DurableObjectNamespace<T> {
	const opts = {
		...DEFAULT_OPTIONS,
		...options,
		isRetryable: options?.isRetryable,
	};

	return new Proxy(namespace, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof value !== 'function') {
				return value;
			}

			// Intercept methods that return a stub
			if (prop === 'get') {
				return (id: DurableObjectId) => {
					const getStub = () => target.get(id);
					return createStubProxy(getStub, opts);
				};
			}

			// Handle getByName (convenience method that creates stub by name)
			if (prop === 'getByName') {
				return (name: string, options?: DurableObjectGetOptions) => {
					const getStub = () => (target as any).getByName(name, options);
					return createStubProxy(getStub, opts);
				};
			}

			// For jurisdiction-specific namespace
			if (prop === 'jurisdiction') {
				return (jurisdiction: DurableObjectJurisdiction) => {
					const jurisdictionNamespace = target.jurisdiction(jurisdiction);
					return withRetry(jurisdictionNamespace, options);
				};
			}

			// Return other methods as-is (idFromName, idFromString, newUniqueId)
			return value.bind(target);
		},
	});
}
