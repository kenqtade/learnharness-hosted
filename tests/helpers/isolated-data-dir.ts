/** Side-effect import: point LH_DATA_DIR at a fresh temp folder BEFORE
 *  config.ts is evaluated (import this first), so a test never writes into
 *  the repo's data/ or data-platform/. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ISOLATED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-isolated-"));
process.env.LH_DATA_DIR = path.join(ISOLATED_DATA_DIR, "data");
