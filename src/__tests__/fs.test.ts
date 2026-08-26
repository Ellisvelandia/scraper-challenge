/** Tests for the rename retry that protects every atomic write on Windows. */
import assert from 'node:assert/strict';
// The helper reads fs.renameSync through a live binding, so the spy goes on the real module object.
const fs = require("fs") as typeof import("fs");
import { renameSyncWithRetry } from '../util/fs';

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: operation not permitted`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

afterEach(() => jest.restoreAllMocks());

test('retries a transient EPERM and succeeds once the lock is released', () => {
  const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    if (spy.mock.calls.length < 3) throw errno('EPERM');
  });
  renameSyncWithRetry('a.tmp', 'a');
  assert.equal(spy.mock.calls.length, 3);
});

test('gives up after the configured attempts and rethrows the lock error', () => {
  const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw errno('EBUSY');
  });
  assert.throws(() => renameSyncWithRetry('a.tmp', 'a', 3), /EBUSY/);
  assert.equal(spy.mock.calls.length, 3);
});

test('does not retry errors that are not share locks', () => {
  const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw errno('ENOENT');
  });
  assert.throws(() => renameSyncWithRetry('missing.tmp', 'a'), /ENOENT/);
  assert.equal(spy.mock.calls.length, 1);
});
