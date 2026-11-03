import { realpath as realpathCallback } from "node:fs";
import { realpath as realpathNative } from "node:fs/promises";
import { promisify } from "node:util";

// App Server canonicalizes owned paths with realpathSync. On Windows, the
// callback implementation preserves the same casing; the native variant does not.
export const realpath = process.platform === "win32" ? promisify(realpathCallback) : realpathNative;
