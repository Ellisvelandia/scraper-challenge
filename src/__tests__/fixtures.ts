/**
 * Resolves the fixtures directory whether the test runs from `src/` (ts-node)
 * or from `dist/` (compiled). Fixtures are not compiled, so the compiled tests
 * reach back into the source tree.
 */
import * as fs from 'fs';
import * as path from 'path';

const candidates = [
  path.join(__dirname, 'fixtures'),
  path.join(__dirname, '..', '..', 'src', '__tests__', 'fixtures'),
];

export const FIXTURES = candidates.find((d) => fs.existsSync(d)) ?? candidates[0]!;

export function readFixture(file: string): string {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}
