import { randomBytes } from "node:crypto";

// minimal ULID (48 time bits + 80 random bits, Crockford base32) — no dependency.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  const rnd = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += B32[rnd[i]! % 32];
  return time + rand;
}

/** ISO 8601 UTC. */
export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}
