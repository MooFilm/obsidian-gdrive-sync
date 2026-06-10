/**
 * Google Drive Sync — Obsidian Plugin Entry Point
 * Near-realtime bidirectional sync between Obsidian vault and Google Drive.
 */

import { Plugin, Notice } from "obsidian";
import { GoogleAuth } from "./src/auth";
import { DriveAPI } from "./src/driveApi";
import { SyncEngine, SyncStatus } from "./src/syncEngine";
import { ConflictHandler } from "./src/conflictHandler";
import {
  GDriveSyncSettingTab,
  GDriveSyncSettings,
  DEFAULT_SETTINGS,
} from "./src/settingsTab";

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings = DEFAULT_SETTINGS;
  auth: GoogleAuth | null = null;
  syncEngine: SyncEngine | null = null;

  private statusBarEl: HTMLElement | null = null;
  private driveApi: DriveAPI | null = null;
  private conflictHandler: ConflictHandler | null = null;

  async onload(): Promise<void> {
    console.log("GDrive Sync: Loading plugin...");

    // Load settings
    await this.loadSettings();

    // Initialize auth
    this.auth = new GoogleAuth({
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
      loadData: () => this.loadPluginData(),
      saveData: (data) => this.savePluginData(data),
    });

    try {
      await this.auth.initialize();
    } catch (err) {
      console.error("GDrive Sync: Auth initialization failed:", err);
    }

    // Initialize Drive API
    this.driveApi = new DriveAPI(this.auth);

    // Initialize conflict handler
    this.conflictHandler = new ConflictHandler(this.app.vault);

    // Initialize sync engine
    const ignorePatterns = this.settings.ignorePatterns
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    this.syncEngine = new SyncEngine(
      this.app.vault,
      this.driveApi,
      this.conflictHandler,
      {
        syncFolderName: this.settings.syncFolderName,
        uploadOnly: this.settings.syncMode === "upload_only",
        pullIntervalSeconds: this.settings.pullIntervalSeconds,
        ignorePatterns,
        loadData: () => this.loadPluginData(),
        saveData: (data) => this.savePluginData(data),
        onStatusChange: (status, message) =>
          this.updateStatusBar(status, message),
      }
    );

    // If authenticated, start syncing
    if (this.auth.isAuthenticated()) {
      try {
        await this.syncEngine.initialize();
        this.syncEngine.start();
      } catch (err) {
        console.error("GDrive Sync: Sync engine init failed:", err);
        // Still load the plugin — user can connect later
      }
    }

    // Status bar
    if (this.settings.showSyncStatusBar) {
      this.statusBarEl = this.addStatusBarItem();
      this.updateStatusBar("idle");
    }

    // Ribbon icon — click to trigger full sync
    this.addRibbonIcon("cloud", "Google Drive Sync", async () => {
      if (!this.auth?.isAuthenticated()) {
        new Notice("Please connect Google Drive in plugin settings first.");
        return;
      }
      await this.syncEngine?.fullSync();
    });

    // Add settings tab
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    // Add command: full sync
    this.addCommand({
      id: "gdrive-full-sync",
      name: "Run full sync with Google Drive",
      callback: async () => {
        if (!this.auth?.isAuthenticated()) {
          new Notice("Please connect Google Drive in plugin settings first.");
          return;
        }
        await this.syncEngine?.fullSync();
      },
    });

    // Add command: connect
    this.addCommand({
      id: "gdrive-connect",
      name: "Connect to Google Drive",
      callback: async () => {
        if (!this.settings.clientId) {
          new Notice("Please set your Client ID in plugin settings first.");
          return;
        }
        await this.auth?.startAuthFlow();
      },
    });

    console.log("GDrive Sync: Plugin loaded successfully.");
  }

  async onunload(): Promise<void> {
    console.log("GDrive Sync: Unloading plugin...");

    // Stop sync engine (clears intervals and debounces)
    this.syncEngine?.stop();

    // Clean up event refs
    const refs = this.syncEngine?.getEventRefs() ?? [];
    for (const ref of refs) {
      this.app.vault.offref(ref);
    }

    // Clean up auth timers
    this.auth?.destroy();

    console.log("GDrive Sync: Plugin unloaded.");
  }

  /**
   * Load plugin settings from disk.
   */
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    if (data?.settings) {
      this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
  }

  /**
   * Save plugin settings to disk.
   */
  async saveSettings(): Promise<void> {
    const data = await this.loadPluginData();
    data["settings"] = this.settings as unknown as Record<string, unknown>;
    await this.savePluginData(data);

    // Update auth if credentials changed
    if (this.auth) {
      this.auth = new GoogleAuth({
        clientId: this.settings.clientId,
        clientSecret: this.settings.clientSecret,
        loadData: () => this.loadPluginData(),
        saveData: (d) => this.savePluginData(d),
      });
      await this.auth.initialize();
    }
  }

  /**
   * Load raw plugin data (wrapper for type safety).
   */
  private async loadPluginData(): Promise<Record<string, unknown>> {
    const data = await this.loadData();
    return (data as Record<string, unknown>) || {};
  }

  /**
   * Save raw plugin data (wrapper for type safety).
   */
  private async savePluginData(data: Record<string, unknown>): Promise<void> {
    await this.saveData(data);
  }

  /**
   * Update the status bar item.
   */
  private updateStatusBar(status: SyncStatus, message?: string): void {
    if (!this.statusBarEl) return;

    switch (status) {
      case "syncing":
        this.statusBarEl.setText(`🔄 ${message || "Syncing..."}`);
        break;
      case "idle": {
        const lastSync = this.syncEngine?.getLastSyncTime() ?? 0;
        const ago = lastSync > 0
          ? `${Math.floor((Date.now() - lastSync) / 1000)}s ago`
          : "never";
        this.statusBarEl.setText(`✅ Synced (${ago})`);
        break;
      }
      case "error":
        this.statusBarEl.setText(`❌ ${message || "Sync error"}`);
        break;
    }
  }
}
