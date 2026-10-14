import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface CacheIndexEntry {
  at: number;
  size: number;
  /** Codec of the stored bytes ('json' for trees, 'identity' for decoded blobs). */
  encoding: string;
}

type CacheIndex = Record<string, CacheIndexEntry>;

export interface CachedObject {
  bytes: Buffer;
  encoding: string;
}

/**
 * Bounded LRU object cache (`~/.yag/objects/{hash[0:2]}/{hash}` + index.json).
 * Blobs are stored exactly as the server serves them (its compressed codec);
 * trees as canonical JSON. Everything is content-addressed and immutable, so
 * eviction is always safe and `yag checkout` reruns resume from the cache.
 */
export class ObjectCache {
  private index: CacheIndex | null = null;

  constructor(
    readonly root: string,
    readonly maxBytes: number = 2 * 1024 * 1024 * 1024,
  ) {}

  private pathFor(hash: string): string {
    return join(this.root, `${hash.slice(0, 2)}`, hash);
  }

  private get indexPath(): string {
    return join(this.root, 'index.json');
  }

  async loadIndex(): Promise<CacheIndex> {
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(await readFile(this.indexPath, 'utf8')) as CacheIndex;
    } catch {
      this.index = {};
    }
    return this.index;
  }

  private async saveIndex(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(this.index ?? {}), 'utf8');
  }

  /** Cached object, or null. Bumps the entry's recency. */
  async get(hash: string): Promise<CachedObject | null> {
    const index = await this.loadIndex();
    try {
      const bytes = await readFile(this.pathFor(hash));
      const entry = index[hash] ?? {
        at: 0,
        size: bytes.byteLength,
        encoding: 'identity',
      };
      index[hash] = { ...entry, at: Date.now(), size: bytes.byteLength };
      await this.saveIndex();
      return { bytes, encoding: entry.encoding };
    } catch {
      return null;
    }
  }

  /** Store bytes under their content hash; evicts LRU on overflow. */
  async put(hash: string, bytes: Buffer, encoding = 'identity'): Promise<void> {
    const target = this.pathFor(hash);
    await mkdir(join(this.root, `${hash.slice(0, 2)}`), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);

    const index = await this.loadIndex();
    index[hash] = { at: Date.now(), size: bytes.byteLength, encoding };
    await this.evict(index);
    await this.saveIndex();
  }

  async has(hash: string): Promise<boolean> {
    return (await this.get(hash)) !== null;
  }

  async totalBytes(): Promise<number> {
    const index = await this.loadIndex();
    return Object.values(index).reduce((sum, e) => sum + e.size, 0);
  }

  private async evict(index: CacheIndex): Promise<void> {
    let total = Object.values(index).reduce((sum, e) => sum + e.size, 0);
    if (total <= this.maxBytes) return;
    const oldest = Object.entries(index).sort((a, b) => a[1].at - b[1].at);
    for (const [hash, entry] of oldest) {
      if (total <= this.maxBytes) break;
      await rm(this.pathFor(hash), { force: true });
      delete index[hash];
      total -= entry.size;
    }
  }
}
