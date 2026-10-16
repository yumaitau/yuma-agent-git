/**
 * Dependency-free ID generation.
 *
 * ULID (Crockford base32): 48-bit millisecond timestamp + 80 bits of
 * randomness — lexicographically sortable by creation time.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `rand` (16 bytes) makes the id deterministic; omitted, it is random. */
export function ulid(now: number = Date.now(), rand?: Uint8Array): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  rand ??= crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += CROCKFORD[rand[i] % 32];
  }
  return time + random;
}
