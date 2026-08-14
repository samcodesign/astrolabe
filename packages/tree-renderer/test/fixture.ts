import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TreeGeometry } from '../src/types';

const PATH = resolve(__dirname, '../../../fixtures/geometry-3_29.json');

let cached: TreeGeometry | null = null;

/** The real 3.29 tree. Loaded once and shared; it is 4.7 MB. */
export function realTree(): TreeGeometry {
  cached ??= JSON.parse(readFileSync(PATH, 'utf8')) as TreeGeometry;
  return cached;
}
