import { mkdirSync, lstatSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Validate a private directory before using it for state or a socket. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error("Relay directory must be an owned, real directory");
  }
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Relay directory is not private (0700)");
}

/**
 * SQLite's OS-backed exclusive lock on a separate database is held for the
 * relay's entire lifetime. Unlike a PID file it is released after SIGKILL and
 * works on local macOS and Linux filesystems without a platform-specific flock.
 * Never put the application tables in this database: its exclusive transaction
 * intentionally prevents all other connections from opening it.
 */
export class RelayOwnership {
  private closed = false;
  private readonly lock: DatabaseSync;
  private constructor(lock: DatabaseSync) {
    this.lock = lock;
  }

  static acquire(directory: string): RelayOwnership {
    ensurePrivateDirectory(directory);
    const file = join(directory, "owner.sqlite");
    // The open with O_NOFOLLOW equivalent is not exposed here via sqlite; an
    // existing symlink must be rejected before sqlite opens it.
    try {
      const fd = openSync(
        file,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const existing = lstatSync(file);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.uid !== process.getuid?.() ||
        (existing.mode & 0o077) !== 0
      ) {
        throw new Error("Relay lock file is not private");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lock = new DatabaseSync(file, { timeout: 0 });
    try {
      lock.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      return new RelayOwnership(lock);
    } catch (error) {
      lock.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.lock.exec("ROLLBACK");
    } finally {
      this.lock.close();
    }
  }
}
