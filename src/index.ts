import { DurableObject } from 'cloudflare:workers';
import { withRetry } from './retry-proxy';

/**
 * BEST PRACTICES: DURABLE OBJECT ERROR HANDLING
 *
 * 1. Distinguish between RETRYABLE (transient) and PERMANENT (logic) errors.
 * 2. Rely on Cloudflare's `.retryable` and `.overloaded` flags for infrastructure issues.
 * 3. NEVER retry when `.overloaded` is true.
 * 4. Define custom Error types to safely identify application-level transient failures.
 */

export class MyDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(req: Request) {
		const url = new URL(req.url);
		const scenario = url.searchParams.get('scenario');

		if (scenario === 'locked') {
			// Throw a specific error type for transient application states
			console.log('Throwing TemporaryError');
			throw new Error('TemporaryError: Database is locked');
		}

		if (scenario === 'invalid') {
			// Permanent errors should never be retried
			console.log('Throwing PermanentError');
			throw new Error('PermanentError: Invalid parameters');
		}

		return new Response('Success');
	}
}

export interface Env {
	MY_DURABLE_OBJECT: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const doNamespace = withRetry(ctx.exports.MyDurableObject, {
			maxAttempts: 5,
			baseDelayMs: 200,

			// Custom predicate to decide which errors require a retry
			isRetryable: (err: any) => {
				const isTemporary = err?.message?.startsWith('TemporaryError:');
				if (err?.remote && isTemporary) {
					console.log('Retrying TemporaryError');
					return true;
				}

				return false;
			},
		});

		const id = doNamespace.idFromName('test');
		const stub = doNamespace.get(id);

		try {
			// Automatically retries on network errors, infrastructure flakes, or TemporaryError
			// Fails fast on Overload or PermanentError
			return await stub.fetch(request);
		} catch (e: any) {
			const isPermanent = e.message?.startsWith('PermanentError:');
			if (e.remote && isPermanent) {
				return new Response('Bad Request: ' + e.message, { status: 400 });
			}
			return new Response('Internal Error: ' + e.message, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
