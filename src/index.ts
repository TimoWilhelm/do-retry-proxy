import { DurableObject } from 'cloudflare:workers';
import { withRetry } from './retry-proxy';

export class MyDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async sayHello(name: string): Promise<string> {
		return `Hello, ${name}!`;
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const namespace = withRetry(env.MY_DURABLE_OBJECT);
		const stub = namespace.getByName('foo');
		const greeting = await stub.sayHello('world');
		return new Response(greeting);
	},
} satisfies ExportedHandler<Env>;

export { withRetry, isErrorRetryable } from './retry-proxy';
export type { RetryOptions } from './retry-proxy';
