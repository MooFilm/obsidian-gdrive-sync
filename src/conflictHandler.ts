/**
 * Conflict resolution logic for Google Drive sync.
 * Compares local modification time vs Drive modifiedTime.
 */

import { Notice, Vault, TFile } from "obsidian";

export interface ConflictResult {
  action: "overwrite_local" | "conflict_saved" | "skip";
  conflictFilePath?: string;
}

/**
 * Threshold in milliseconds: if both files are modified within this window,
 * treat as a conflict rather than simply picking the newest.
 */
const CONFLICT_WINDOW_MS = 60_000; // 60 seconds

export class ConflictHandler {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * Resolve a conflict between local and remote versions of a file.
   *
   * @param localPath    Path of the file in the vault
   * @param driveModTime ISO string of the Drive file's modifiedTime
   * @param driveContent The content from Google Drive
   * @returns ConflictResult indicating what action was taken
   */
  async resolve(
    localPath: string,
    driveModTime: string,
    driveContent: string
  ): Promise<ConflictResult> {
    const file = this.vault.getAbstractFileByPath(localPath);

    if (!file || !(file instanceof TFile)) {
      // File doesn't exist locally — no conflict, just write it
      return { action: "overwrite_local" };
    }

    const localMtime = file.stat.mtime; // Unix timestamp in ms
    const driveMtime = new Date(driveModTime).getTime();

    // If Drive is clearly newer (local hasn't been modified recently)
    if (driveMtime > localMtime && driveMtime - localMtime > CONFLICT_WINDOW_MS) {
      return { action: "overwrite_local" };
    }

    // If local is clearly newer — skip the pull (local version wins,
    // and will be pushed on next push cycle)
    if (localMtime > driveMtime && localMtime - driveMtime > CONFLICT_WINDOW_MS) {
      return { action: "skip" };
    }

    // Both modified within the conflict window — save conflict copy
    const localContent = await this.vault.read(file);

    // If content is identical, no conflict
    if (localContent === driveContent) {
      return { action: "skip" };
    }

    // Create a conflict file
    const timestamp = this.formatTimestamp(new Date());
    const conflictPath = this.createConflictPath(localPath, timestamp);

    // Save the local version as a conflict file
    await this.vault.create(conflictPath, localContent);

    // Notify the user
    new Notice(
      `⚠️ Sync conflict detected!\n${localPath}\nLocal version saved as:\n${conflictPath}`,
      10000
    );

    console.warn(
      `GDrive Sync: Conflict on "${localPath}". ` +
        `Local mtime=${new Date(localMtime).toISOString()}, ` +
        `Drive mtime=${driveModTime}. ` +
        `Local copy saved to "${conflictPath}".`
    );

    // Overwrite local with Drive version (Drive wins), user has the conflict copy
    return { action: "conflict_saved", conflictFilePath: conflictPath };
  }

  /**
   * Generate a conflict file path.
   * "notes/hello.md" → "notes/hello.conflict-20260510-160530.md"
   */
  private createConflictPath(originalPath: string, timestamp: string): string {
    const lastDot = originalPath.lastIndexOf(".");
    if (lastDot === -1) {
      return `${originalPath}.conflict-${timestamp}`;
    }
    const base = originalPath.substring(0, lastDot);
    const ext = originalPath.substring(lastDot);
    return `${base}.conflict-${timestamp}${ext}`;
  }

  /**
   * Format a Date as "YYYYMMDD-HHmmss".
   */
  private formatTimestamp(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
  }
}
