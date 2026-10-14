/**
 * Project root resolution
 * Finds the repository root (the folder holding package.json) so data and static
 * files resolve to the same place whether code runs from source or from dist/.
 */

import * as fs from 'fs';
import * as path from 'path';

const cache = new Map<string, string>();

/**
 * Walk up from `startDir` to the nearest folder that contains a package.json.
 * Throws if none is found before the filesystem root.
 */
export function findProjectRoot(startDir: string = __dirname): string {
  const start = path.resolve(startDir);
  const cached = cache.get(start);
  if (cached) return cached;

  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cache.set(start, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No package.json found above ${start}`);
    }
    dir = parent;
  }
}

/**
 * Resolve a path relative to the project root, e.g. projectPath('dashboard', 'logs').
 */
export function projectPath(...segments: string[]): string {
  return path.join(findProjectRoot(), ...segments);
}
