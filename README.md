# do-retry-proxy

Transparent retry proxy for Cloudflare Durable Objects. Wraps a `DurableObjectNamespace` so all RPC calls automatically retry on transient failures with exponential backoff and jitter. A fresh stub is created on each retry to recover from broken stub state.

## Usage

```ts
import { withRetry } from './retry-proxy';

const namespace = withRetry(env.MY_DURABLE_OBJECT);
const stub = namespace.getByName('foo');

// Automatically retries on transient failures
const result = await stub.sayHello('world');
```

### Options

```ts
const namespace = withRetry(env.MY_DURABLE_OBJECT, {
  maxAttempts: 3,    // default: 3
  baseDelayMs: 100,  // default: 100
  maxDelayMs: 3000,  // default: 3000
  isRetryable: (err) => boolean, // custom retry predicate
});
```

### Retry behavior

- Retries errors with `retryable: true` (per [Cloudflare best practices](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/))
- Skips retry for overloaded errors (`overloaded: true` or message contains "Durable Object is overloaded")
- Uses full-jitter exponential backoff via `scheduler.wait()`

## Development

```sh
npm run dev       # local dev server
npm run test      # run tests
npm run deploy    # deploy to Cloudflare
```
