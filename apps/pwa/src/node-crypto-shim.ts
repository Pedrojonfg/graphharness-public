// Browser stand-in for `node:crypto` (aliased in vite.config.ts). contracts and core import it
// in server-side functions (`ulid`, error-pattern hashing) that the PWA does not use; only what
// has a direct Web Crypto equivalent is offered here.
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function createHash(): never {
  throw new Error("createHash is not available in the PWA (Hub only).");
}
