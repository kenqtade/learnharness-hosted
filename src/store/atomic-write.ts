/**
 * Crash-safe file replacement for the store adapters (#403).
 *
 * writeFileAtomicSync(file, text) writes a temp beside the target, fsyncs it,
 * and renames it over the target. On this path readers see the old bytes or
 * the complete new bytes. Callers keep building the exact bytes and keep
 * their own mkdirSync. Previously in-place writers explicitly opt into the
 * Windows compatibility fallback; previously atomic writers do not.
 *
 *   writeFileAtomicSync(file, JSON.stringify(record, null, "\t"));
 *   writeFileAtomicSync(AUTH_FILE, text, { mode: 0o600 }); // secrets
 *   removeLeftoverTemps(file); // after deleting `file`
 *
 * Limits:
 *  - The rename path protects against process interruption during writes.
 *    The folder is not fsynced: this is not a power-loss durability guarantee.
 *  - No locking: two writers of one file still race, and the last one wins.
 *  - Windows refuses to rename over files another process holds open
 *    (antivirus, the Search indexer, backup tools). The rename is retried for
 *    about 100 ms, blocking the thread. If still held, only callers with
 *    allowInPlaceFallback save in place (the pre-#403 interruption risk),
 *    and never through a symlink.
 *    The fsynced temp stays until that write lands, and is kept if it fails
 *    midway. Other callers throw, leaving the old file untouched.
 *  - Rename replaces the named path, including a symlink, not its referent.
 *  - Crashes can leave `<file>.tmp-<uuid>` beside the target. Store listings
 *    only read names ending in .json or .md, so they skip it.
 *  - New files get `mode` (default 0o666 minus umask), not the old file's.
 *
 * HOSTED FORK (storage seam): the real-disk algorithm lives in vfs.ts, the
 * one module allowed to touch node:fs (tests/storage-seam.test.ts). There,
 * a path the seam manages (Convex mode, or a member's data space) is saved
 * through the seam — a Convex record write is already all-or-nothing — and
 * every other path gets exactly the algorithm described above.
 */
export { writeFileAtomicSync, removeLeftoverTemps } from "./vfs.ts";
