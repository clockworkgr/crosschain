import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write to a temp file, fsync, rename. The file is either the old or the new content, never half. */
export function writeAtomic(path: string, data: Uint8Array): void {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // The rename itself must reach the disk too, or a crash can bring the old file back.
  try {
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (e) {
    // Some platforms refuse to fsync a directory handle at all; the file write above was still synced.
    // A failure of the sync itself is a different matter and must surface.
    const code = (e as NodeJS.ErrnoException).code;
    if (!code || !['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR', 'EBADF', 'EACCES'].includes(code)) throw e;
  }
}
