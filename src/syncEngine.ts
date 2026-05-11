/**
 * Core sync engine: push local changes to Drive, pull remote changes to vault.
 * Handles debouncing, offline queues, write-back protection, and active editing protection.
 */

import { Notice, Vault, TFile, TAbstractFile, EventRef } from "obsidian";
import { DriveAPI, DriveChange } from "./driveApi";
import { ConflictHandler } from "./conflictHandler";

export type SyncStatus = "idle" | "syncing" | "error";

export interface SyncEngineConfig {
  syncFolderName: string;
  pullIntervalSeconds: number;
  ignorePatterns: string[];
  loadData: () => Promise<Record<string, unknown>>;
  saveData: (data: Record<string, unknown>) => Promise<void>;
  onStatusChange: (status: SyncStatus, message?: string) => void;
}

interface SyncData {
  fileMap: Record<string, string>; // localPath → driveFileId
  reverseMap: Record<string, string>; // driveFileId → localPath
  folderId: string | null;
  pageToken: string | null;
  pendingQueue: string[]; // paths that failed to upload
  lastSyncTime: number;
  // Sub-folder ID mapping: relative folder path → Drive folder ID
  folderMap: Record<string, string>;
}

const DEBOUNCE_MS = 2000;
const DEFAULT_MIME = "text/markdown";

/**
 * Grace period after a local edit: during this time, remote changes for the
 * same file will be skipped to prevent overwriting the user's active work.
 */
const EDIT_GRACE_PERIOD_MS = 30_000; // 30 seconds

export class SyncEngine {
  private vault: Vault;
  private driveApi: DriveAPI;
  private conflictHandler: ConflictHandler;
  private config: SyncEngineConfig;

  private syncData: SyncData = {
    fileMap: {},
    reverseMap: {},
    folderId: null,
    pageToken: null,
    pendingQueue: [],
    lastSyncTime: 0,
    folderMap: {},
  };

  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private currentlyWriting: Set<string> = new Set();

  /**
   * Track the last time each file was locally edited (by the user).
   * Used to enforce the edit grace period — remote changes arriving during
   * this window will be deferred rather than overwriting the user's work.
   */
  private lastLocalEditTime: Map<string, number> = new Map();

  private isPushing = false;
  private isPulling = false;
  private pullInterval: ReturnType<typeof setInterval> | null = null;
  private eventRefs: EventRef[] = [];
  private status: SyncStatus = "idle";

  constructor(
    vault: Vault,
    driveApi: DriveAPI,
    conflictHandler: ConflictHandler,
    config: SyncEngineConfig
  ) {
    this.vault = vault;
    this.driveApi = driveApi;
    this.conflictHandler = conflictHandler;
    this.config = config;
  }

  /**
   * Initialize the sync engine: load saved state, ensure Drive folder exists.
   */
  async initialize(): Promise<void> {
    await this.loadSyncData();

    try {
      // Ensure the sync folder exists on Drive
      if (!this.syncData.folderId) {
        this.syncData.folderId = await this.driveApi.ensureFolder(
          this.config.syncFolderName
        );
        await this.saveSyncData();
      }

      // Get initial page token if we don't have one
      if (!this.syncData.pageToken) {
        this.syncData.pageToken = await this.driveApi.getStartPageToken();
        await this.saveSyncData();
      }

      // Flush any pending uploads from previous session
      await this.flushPendingQueue();
    } catch (err) {
      console.error("GDrive Sync: Initialization error:", err);
      // Don't throw — allow offline startup
    }
  }

  /**
   * Start listening for vault events and begin periodic pull.
   */
  start(): void {
    // Register vault event listeners
    const modifyRef = this.vault.on("modify", (file: TAbstractFile) => {
      if (file instanceof TFile) {
        this.handleLocalChange(file.path);
      }
    });

    const createRef = this.vault.on("create", (file: TAbstractFile) => {
      if (file instanceof TFile) {
        this.handleLocalChange(file.path);
      }
    });

    const deleteRef = this.vault.on("delete", (file: TAbstractFile) => {
      if (file instanceof TFile) {
        this.handleLocalDelete(file.path);
      }
    });

    const renameRef = this.vault.on(
      "rename",
      (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          this.handleLocalRename(file.path, oldPath);
        }
      }
    );

    this.eventRefs.push(modifyRef, createRef, deleteRef, renameRef);

    // Start periodic pull
    this.pullInterval = setInterval(
      () => this.pull(),
      this.config.pullIntervalSeconds * 1000
    );

    this.setStatus("idle");
  }

  /**
   * Stop all event listeners and intervals.
   */
  stop(): void {
    // Clear pull interval
    if (this.pullInterval) {
      clearInterval(this.pullInterval);
      this.pullInterval = null;
    }

    // Cancel all pending debounces
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Obsidian handles unregistering via offref, but we store refs for cleanup
    this.eventRefs = [];
  }

  /**
   * Perform a full sync: push all local files, then pull remote changes.
   */
  async fullSync(): Promise<void> {
    this.setStatus("syncing", "Full sync in progress...");
    new Notice("🔄 Starting full sync...");

    try {
      // Ensure folder exists
      if (!this.syncData.folderId) {
        this.syncData.folderId = await this.driveApi.ensureFolder(
          this.config.syncFolderName
        );
      }

      // Push all local files
      const files = this.vault.getFiles();
      let uploaded = 0;
      let skipped = 0;

      for (const file of files) {
        if (this.shouldIgnore(file.path)) {
          skipped++;
          continue;
        }

        try {
          await this.pushFile(file.path);
          uploaded++;
        } catch (err) {
          console.error(`GDrive Sync: Failed to upload ${file.path}:`, err);
          this.addToPendingQueue(file.path);
        }
      }

      // Get fresh page token
      this.syncData.pageToken = await this.driveApi.getStartPageToken();
      this.syncData.lastSyncTime = Date.now();
      await this.saveSyncData();

      new Notice(`✅ Full sync complete! Uploaded: ${uploaded}, Skipped: ${skipped}`);
      this.setStatus("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`❌ Full sync failed: ${msg}`);
      this.setStatus("error", msg);
    }
  }

  /**
   * Handle a local file modification or creation (debounced).
   */
  private handleLocalChange(path: string): void {
    // Skip if this write was triggered by a pull (write-back protection)
    if (this.currentlyWriting.has(path)) {
      return;
    }

    if (this.shouldIgnore(path)) return;

    // Record the edit time — this is used by the pull logic to avoid
    // overwriting files that the user is actively editing.
    this.lastLocalEditTime.set(path, Date.now());

    // Cancel existing debounce for this file
    const existing = this.debounceTimers.get(path);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounce
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.pushFile(path).catch((err) => {
        console.error(`GDrive Sync: Push failed for ${path}:`, err);
        this.addToPendingQueue(path);
      });
    }, DEBOUNCE_MS);

    this.debounceTimers.set(path, timer);
  }

  /**
   * Handle a local file deletion.
   */
  private async handleLocalDelete(path: string): Promise<void> {
    if (this.shouldIgnore(path)) return;

    const fileId = this.syncData.fileMap[path];
    if (!fileId) return;

    try {
      await this.driveApi.trashFile(fileId);
      delete this.syncData.fileMap[path];
      delete this.syncData.reverseMap[fileId];
      await this.saveSyncData();
    } catch (err) {
      console.error(`GDrive Sync: Failed to trash ${path} on Drive:`, err);
    }
  }

  /**
   * Handle a local file rename.
   */
  private async handleLocalRename(newPath: string, oldPath: string): Promise<void> {
    if (this.shouldIgnore(newPath)) return;

    const fileId = this.syncData.fileMap[oldPath];
    if (fileId) {
      // Update maps
      delete this.syncData.fileMap[oldPath];
      this.syncData.fileMap[newPath] = fileId;
      this.syncData.reverseMap[fileId] = newPath;
      await this.saveSyncData();
    }

    // Re-upload with new name
    this.handleLocalChange(newPath);
  }

  /**
   * Push a single file to Google Drive.
   */
  private async pushFile(path: string): Promise<void> {
    this.isPushing = true;
    this.setStatus("syncing", `Uploading: ${path}`);

    try {
      const file = this.vault.getAbstractFileByPath(path);
      if (!file || !(file instanceof TFile)) return;

      const content = await this.vault.read(file);
      const mimeType = this.getMimeType(path);
      const existingId = this.syncData.fileMap[path];

      // Ensure parent folders exist on Drive
      const parentFolderId = await this.ensureDriveParentFolders(path);

      const fileId = await this.driveApi.uploadFile(
        this.getFileName(path),
        content,
        mimeType,
        existingId,
        parentFolderId
      );

      // Update maps
      this.syncData.fileMap[path] = fileId;
      this.syncData.reverseMap[fileId] = path;
      this.syncData.lastSyncTime = Date.now();
      await this.saveSyncData();

      // Remove from pending queue if it was there
      this.removeFromPendingQueue(path);
    } finally {
      this.isPushing = false;
      this.setStatus("idle");
    }
  }

  /**
   * Ensure all parent directories for a file path exist on Drive.
   * Returns the Drive folder ID for the immediate parent.
   */
  private async ensureDriveParentFolders(localPath: string): Promise<string> {
    const parts = localPath.split("/");
    if (parts.length <= 1) {
      // File is at vault root → goes into the sync folder
      return this.syncData.folderId!;
    }

    // Remove the filename, keep only directory parts
    const dirParts = parts.slice(0, -1);
    let currentParentId = this.syncData.folderId!;

    for (let i = 0; i < dirParts.length; i++) {
      const relativePath = dirParts.slice(0, i + 1).join("/");
      const cachedId = this.syncData.folderMap[relativePath];

      if (cachedId) {
        currentParentId = cachedId;
        continue;
      }

      // Check if folder exists on Drive
      const existingId = await this.driveApi.findFolder(
        dirParts[i],
        currentParentId
      );

      if (existingId) {
        this.syncData.folderMap[relativePath] = existingId;
        currentParentId = existingId;
      } else {
        // Create folder
        const newId = await this.driveApi.createFolder(
          dirParts[i],
          currentParentId
        );
        this.syncData.folderMap[relativePath] = newId;
        currentParentId = newId;
      }
    }

    await this.saveSyncData();
    return currentParentId;
  }

  /**
   * Check if a file is currently being actively edited by the user.
   * A file is considered "actively edited" if:
   *   1. There is a pending debounce timer for it, OR
   *   2. It was last edited within the EDIT_GRACE_PERIOD_MS
   */
  private isActivelyEditing(path: string): boolean {
    // Check for pending debounce (user just typed something, push hasn't fired yet)
    if (this.debounceTimers.has(path)) {
      return true;
    }

    // Check the edit grace period
    const lastEdit = this.lastLocalEditTime.get(path);
    if (lastEdit && Date.now() - lastEdit < EDIT_GRACE_PERIOD_MS) {
      return true;
    }

    return false;
  }

  /**
   * Pull changes from Google Drive.
   */
  private async pull(): Promise<void> {
    // Skip if currently pushing or pulling
    if (this.isPushing || this.isPulling) return;
    if (!this.syncData.pageToken || !this.syncData.folderId) return;

    this.isPulling = true;
    this.setStatus("syncing", "Checking for changes...");

    try {
      const result = await this.driveApi.getChanges(this.syncData.pageToken);

      for (const change of result.changes) {
        await this.processChange(change);
      }

      this.syncData.pageToken = result.newPageToken;
      this.syncData.lastSyncTime = Date.now();
      await this.saveSyncData();

      // Try to flush pending queue on successful network call
      if (this.syncData.pendingQueue.length > 0) {
        await this.flushPendingQueue();
      }

      this.setStatus("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Don't spam errors for network issues
      if (msg.includes("Network error")) {
        this.setStatus("error", "Offline");
      } else {
        console.error("GDrive Sync: Pull failed:", err);
        this.setStatus("error", msg);
      }
    } finally {
      this.isPulling = false;
    }
  }

  /**
   * Process a single change from the Drive changes API.
   */
  private async processChange(change: DriveChange): Promise<void> {
    const { fileId, file, removed } = change;

    // Find the local path for this file
    const localPath = this.syncData.reverseMap[fileId];

    if (removed || file?.trashed) {
      // File was deleted/trashed on Drive
      if (localPath) {
        // Don't delete a file the user is actively editing!
        if (this.isActivelyEditing(localPath)) {
          console.log(
            `GDrive Sync: Skipping remote delete for "${localPath}" — file is being edited locally.`
          );
          return;
        }

        const existingFile = this.vault.getAbstractFileByPath(localPath);
        if (existingFile && existingFile instanceof TFile) {
          this.currentlyWriting.add(localPath);
          try {
            await this.vault.delete(existingFile);
          } finally {
            this.currentlyWriting.delete(localPath);
          }
        }
        delete this.syncData.fileMap[localPath];
        delete this.syncData.reverseMap[fileId];
      }
      return;
    }

    if (!file) return;

    // Skip folders
    if (file.mimeType === "application/vnd.google-apps.folder") return;

    // Check if this file belongs to our sync folder
    if (
      file.parents &&
      !this.isInSyncFolder(file.parents)
    ) {
      return;
    }

    // Determine local path
    const targetPath = localPath || this.driveNameToLocalPath(file.name);

    // ═══════════════════════════════════════════════════════
    // ACTIVE EDITING PROTECTION
    // If the user is currently editing this file, skip the
    // remote change entirely. The local version will be pushed
    // to Drive on the next push cycle, which resolves the conflict
    // naturally (local wins because it's newer).
    // ═══════════════════════════════════════════════════════
    if (this.isActivelyEditing(targetPath)) {
      console.log(
        `GDrive Sync: Skipping remote change for "${targetPath}" — file is being edited locally.`
      );
      return;
    }

    // Download the file content
    const content = await this.driveApi.downloadFile(fileId);

    // Conflict resolution
    const conflictResult = await this.conflictHandler.resolve(
      targetPath,
      file.modifiedTime,
      content
    );

    if (conflictResult.action === "skip") {
      return;
    }

    // Write to vault (with write-back protection)
    this.currentlyWriting.add(targetPath);
    try {
      const existingFile = this.vault.getAbstractFileByPath(targetPath);
      if (existingFile && existingFile instanceof TFile) {
        await this.vault.modify(existingFile, content);
      } else {
        // Ensure parent directory exists
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (parentDir) {
          await this.ensureVaultFolder(parentDir);
        }
        await this.vault.create(targetPath, content);
      }

      // Update maps
      this.syncData.fileMap[targetPath] = fileId;
      this.syncData.reverseMap[fileId] = targetPath;
    } finally {
      // Remove from writing set after a brief delay to catch any triggered events
      setTimeout(() => {
        this.currentlyWriting.delete(targetPath);
      }, 500);
    }
  }

  /**
   * Ensure a folder path exists in the vault.
   */
  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(folderPath);
    if (existing) return;

    // Create parent folders recursively
    const parts = folderPath.split("/");
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        await this.vault.createFolder(currentPath);
      }
    }
  }

  /**
   * Check if a file's parents include our sync folder (or its subfolders).
   */
  private isInSyncFolder(parents: string[]): boolean {
    if (!this.syncData.folderId) return false;

    // Check if any parent is the sync folder or a known subfolder
    const knownFolderIds = new Set([
      this.syncData.folderId,
      ...Object.values(this.syncData.folderMap),
    ]);

    return parents.some((p) => knownFolderIds.has(p));
  }

  /**
   * Convert a Drive file name back to a local vault path.
   */
  private driveNameToLocalPath(driveName: string): string {
    // Drive file names store the original filename (without directory path)
    // This is a simple mapping; sub-folder resolution happens via folder structure
    return driveName;
  }

  /**
   * Get just the filename from a path.
   */
  private getFileName(path: string): string {
    const parts = path.split("/");
    return parts[parts.length - 1];
  }

  /**
   * Determine MIME type from file extension.
   */
  private getMimeType(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      md: "text/markdown",
      txt: "text/plain",
      json: "application/json",
      css: "text/css",
      js: "application/javascript",
      html: "text/html",
      xml: "application/xml",
      yaml: "text/yaml",
      yml: "text/yaml",
      csv: "text/csv",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      pdf: "application/pdf",
      canvas: "application/json",
    };
    return mimeMap[ext || ""] || "application/octet-stream";
  }

  /**
   * Check if a path matches any ignore pattern.
   */
  private shouldIgnore(path: string): boolean {
    for (const pattern of this.config.ignorePatterns) {
      const trimmed = pattern.trim();
      if (!trimmed) continue;

      // Simple glob matching
      if (trimmed.endsWith("/")) {
        // Directory pattern
        if (path.startsWith(trimmed) || path.startsWith(trimmed.slice(0, -1))) {
          return true;
        }
      } else if (trimmed.includes("*")) {
        // Wildcard pattern
        const regex = new RegExp(
          "^" + trimmed.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
        );
        if (regex.test(path)) {
          return true;
        }
      } else {
        // Exact match or prefix match
        if (path === trimmed || path.startsWith(trimmed + "/") || path.startsWith(trimmed)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Add a file to the pending upload queue.
   */
  private addToPendingQueue(path: string): void {
    if (!this.syncData.pendingQueue.includes(path)) {
      this.syncData.pendingQueue.push(path);
      this.saveSyncData().catch(console.error);
    }
  }

  /**
   * Remove a file from the pending queue.
   */
  private removeFromPendingQueue(path: string): void {
    const idx = this.syncData.pendingQueue.indexOf(path);
    if (idx !== -1) {
      this.syncData.pendingQueue.splice(idx, 1);
      this.saveSyncData().catch(console.error);
    }
  }

  /**
   * Flush the pending upload queue.
   */
  private async flushPendingQueue(): Promise<void> {
    const queue = [...this.syncData.pendingQueue];
    if (queue.length === 0) return;

    for (const path of queue) {
      try {
        await this.pushFile(path);
        this.removeFromPendingQueue(path);
      } catch (err) {
        console.error(`GDrive Sync: Retry failed for ${path}:`, err);
        // Leave in queue for next attempt
        break; // Stop if network is down
      }
    }
  }

  /**
   * Load sync data from plugin storage.
   */
  private async loadSyncData(): Promise<void> {
    const data = await this.config.loadData();
    if (data["syncData"]) {
      const saved = data["syncData"] as Record<string, unknown>;
      this.syncData = {
        fileMap: (saved.fileMap as Record<string, string>) || {},
        reverseMap: (saved.reverseMap as Record<string, string>) || {},
        folderId: (saved.folderId as string) || null,
        pageToken: (saved.pageToken as string) || null,
        pendingQueue: (saved.pendingQueue as string[]) || [],
        lastSyncTime: (saved.lastSyncTime as number) || 0,
        folderMap: (saved.folderMap as Record<string, string>) || {},
      };
    }
  }

  /**
   * Save sync data to plugin storage.
   */
  private async saveSyncData(): Promise<void> {
    const data = await this.config.loadData();
    data["syncData"] = this.syncData as unknown as Record<string, unknown>;
    await this.config.saveData(data);
  }

  /**
   * Set the current sync status.
   */
  private setStatus(status: SyncStatus, message?: string): void {
    this.status = status;
    this.config.onStatusChange(status, message);
  }

  /**
   * Get the current sync status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Get last sync time.
   */
  getLastSyncTime(): number {
    return this.syncData.lastSyncTime;
  }

  /**
   * Get the pending queue length.
   */
  getPendingCount(): number {
    return this.syncData.pendingQueue.length;
  }

  /**
   * Get event refs for cleanup.
   */
  getEventRefs(): EventRef[] {
    return this.eventRefs;
  }
}
