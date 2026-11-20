// Exam Prep — one JSON document on disk with a revision number.
// Hosted-safe by construction (integration owner; tracks use, don't edit):
//  - plain node:fs → on a hosted server the host routes it to Convex;
//  - every read re-reads the file when another serverless instance may have
//    written it (cheap: the host's store is in memory per request);
//  - every change is read → modify → write with revision + 1, atomically
//    (temp file + rename), so readers never see half a file.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Versioned { revision: number }

export class JsonStore<T extends Versioned> {
  private cached: T | undefined;
  constructor(private readonly file: string, private readonly empty: () => T, private readonly validate: (value: unknown) => T = v => v as T) {}

  /** The newest stored value (re-read every call; falls back to the cache if unreadable). */
  get(): T {
    try {
      const value = this.validate(JSON.parse(fs.readFileSync(this.file, "utf8")));
      if (!this.cached || value.revision !== this.cached.revision) this.cached = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.cached ??= this.empty();
      else if (!this.cached) throw new Error(`Could not read ${path.basename(this.file)}: ${(error as Error).message}`);
    }
    return this.cached!;
  }

  /** Apply `mutate` to a fresh copy of the newest value and save it (revision + 1). */
  change<R>(mutate: (draft: T) => R): R {
    const draft = structuredClone(this.get());
    const result = mutate(draft);
    draft.revision = this.get().revision + 1;
    this.write(draft);
    return result;
  }

  private write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = path.join(path.dirname(this.file), `.${path.basename(this.file)}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    this.cached = value;
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
