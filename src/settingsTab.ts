/**
 * Obsidian Settings Tab for Google Drive Sync plugin.
 */

import { App, PluginSettingTab, Setting, TextAreaComponent, Notice } from "obsidian";
import type GDriveSyncPlugin from "../main";

export interface GDriveSyncSettings {
  clientId: string;
  clientSecret: string;
  syncFolderName: string;
  pullIntervalSeconds: number;
  ignorePatterns: string;
  showSyncStatusBar: boolean;
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  clientId: "",
  clientSecret: "",
  syncFolderName: "ObsidianVault",
  pullIntervalSeconds: 10,
  ignorePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/cache",
    ".trash/",
  ].join("\n"),
  showSyncStatusBar: true,
};

export class GDriveSyncSettingTab extends PluginSettingTab {
  plugin: GDriveSyncPlugin;

  constructor(app: App, plugin: GDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ═══════════════════════════════════════
    // Header
    // ═══════════════════════════════════════
    containerEl.createEl("h1", { text: "Google Drive Sync" });
    containerEl.createEl("p", {
      text: "Near-realtime sync between your Obsidian vault and Google Drive.",
      cls: "setting-item-description",
    });

    // ═══════════════════════════════════════
    // Authentication Section
    // ═══════════════════════════════════════
    containerEl.createEl("h2", { text: "Authentication" });

    // Client ID
    new Setting(containerEl)
      .setName("Google OAuth Client ID")
      .setDesc(
        "Create a project in Google Cloud Console, enable Drive API, " +
          "and create an OAuth 2.0 Client ID (Desktop app type). Paste the Client ID here."
      )
      .addText((text) =>
        text
          .setPlaceholder("xxxxxxxxxxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Client Secret
    new Setting(containerEl)
      .setName("Google OAuth Client Secret")
      .setDesc(
        "Copy the Client Secret from the same OAuth 2.0 Client ID page in Google Cloud Console."
      )
      .addText((text) =>
        text
          .setPlaceholder("GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Connection status
    const isConnected = this.plugin.auth?.isAuthenticated() ?? false;

    const statusSetting = new Setting(containerEl)
      .setName("Connection Status")
      .setDesc(isConnected ? "✅ Connected to Google Drive" : "❌ Not connected");

    if (!isConnected) {
      // Connect button
      statusSetting.addButton((btn) =>
        btn
          .setButtonText("Connect Google Drive")
          .setCta()
          .onClick(async () => {
            if (!this.plugin.settings.clientId) {
              new Notice("Please enter your Client ID first.");
              return;
            }
            await this.plugin.auth?.startAuthFlow();
          })
      );
    } else {
      // Disconnect button
      statusSetting.addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.plugin.auth?.disconnect();
            this.display(); // Refresh the settings UI
          })
      );
    }

    // Auth code input (for completing OAuth on any platform)
    new Setting(containerEl)
      .setName("Authorization Code")
      .setDesc(
        "After authorizing in the browser, paste the authorization code here. " +
          "On desktop, copy the 'code' parameter from the localhost redirect URL."
      )
      .addText((text) =>
        text.setPlaceholder("Paste auth code here").onChange(() => {
          // No auto-save; handled by button
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Submit Code").onClick(async () => {
          const input = containerEl.querySelector(
            'input[placeholder="Paste auth code here"]'
          ) as HTMLInputElement | null;
          const code = input?.value?.trim();
          if (!code) {
            new Notice("Please paste the authorization code first.");
            return;
          }
          try {
            await this.plugin.auth?.exchangeCodeManually(code);
            if (input) input.value = "";
            this.display(); // Refresh
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`❌ Code exchange failed: ${msg}`);
          }
        })
      );

    // ═══════════════════════════════════════
    // Sync Configuration Section
    // ═══════════════════════════════════════
    containerEl.createEl("h2", { text: "Sync Configuration" });

    // Sync folder name
    new Setting(containerEl)
      .setName("Drive Folder Name")
      .setDesc("Name of the folder in Google Drive root to sync with.")
      .addText((text) =>
        text
          .setPlaceholder("ObsidianVault")
          .setValue(this.plugin.settings.syncFolderName)
          .onChange(async (value) => {
            this.plugin.settings.syncFolderName = value.trim() || "ObsidianVault";
            await this.plugin.saveSettings();
          })
      );

    // Pull interval
    new Setting(containerEl)
      .setName("Pull Interval (seconds)")
      .setDesc("How often to check Google Drive for changes. Min: 5, Max: 60.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 60, 1)
          .setValue(this.plugin.settings.pullIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pullIntervalSeconds = value;
            await this.plugin.saveSettings();
          })
      );

    // Ignore patterns
    new Setting(containerEl)
      .setName("Ignore Patterns")
      .setDesc(
        "Files/folders matching these patterns will not be synced. One pattern per line. " +
          "Use trailing / for directories."
      )
      .addTextArea((textarea: TextAreaComponent) => {
        textarea
          .setPlaceholder(".obsidian/workspace\n.trash/")
          .setValue(this.plugin.settings.ignorePatterns)
          .onChange(async (value) => {
            this.plugin.settings.ignorePatterns = value;
            await this.plugin.saveSettings();
          });
        textarea.inputEl.rows = 6;
        textarea.inputEl.cols = 40;
      });

    // Status bar toggle
    new Setting(containerEl)
      .setName("Show Status Bar")
      .setDesc("Display sync status icon in the bottom status bar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSyncStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showSyncStatusBar = value;
            await this.plugin.saveSettings();
          })
      );

    // ═══════════════════════════════════════
    // Actions Section
    // ═══════════════════════════════════════
    containerEl.createEl("h2", { text: "Actions" });

    // Full sync button
    new Setting(containerEl)
      .setName("Full Sync")
      .setDesc("Upload all vault files to Drive and pull all remote changes.")
      .addButton((btn) =>
        btn
          .setButtonText("Run Full Sync")
          .setCta()
          .onClick(async () => {
            if (!this.plugin.auth?.isAuthenticated()) {
              new Notice("Please connect Google Drive first.");
              return;
            }
            await this.plugin.syncEngine?.fullSync();
          })
      );

    // ═══════════════════════════════════════
    // Status Section
    // ═══════════════════════════════════════
    containerEl.createEl("h2", { text: "Status" });

    // Last sync time
    const lastSync = this.plugin.syncEngine?.getLastSyncTime() ?? 0;
    const lastSyncText = lastSync > 0 ? this.formatRelativeTime(lastSync) : "Never";

    new Setting(containerEl)
      .setName("Last Synced")
      .setDesc(lastSyncText);

    // Pending uploads
    const pendingCount = this.plugin.syncEngine?.getPendingCount() ?? 0;
    if (pendingCount > 0) {
      new Setting(containerEl)
        .setName("Pending Uploads")
        .setDesc(`${pendingCount} file(s) waiting to be uploaded (offline queue).`);
    }

    // ═══════════════════════════════════════
    // Setup Instructions
    // ═══════════════════════════════════════
    containerEl.createEl("h2", { text: "Setup Instructions" });

    const instructions = containerEl.createEl("div", { cls: "gdrive-sync-instructions" });
    instructions.createEl("ol", {}, (ol) => {
      ol.createEl("li", {
        text: 'Go to Google Cloud Console → Create a new project (or select existing)',
      });
      ol.createEl("li", {
        text: 'Navigate to "APIs & Services" → "Library" → Enable "Google Drive API"',
      });
      ol.createEl("li", {
        text: 'Go to "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth client ID"',
      });
      ol.createEl("li", {
        text: 'Choose "Desktop app" as application type → Create',
      });
      ol.createEl("li", {
        text: "Copy the Client ID and paste it above",
      });
      ol.createEl("li", {
        text: 'Click "Connect Google Drive" and authorize in the browser',
      });
      ol.createEl("li", {
        text: "After redirecting, copy the authorization code and paste it above",
      });
    });
  }

  /**
   * Format a Unix timestamp as a relative time string.
   */
  private formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 5) return "Just now";
    if (seconds < 60) return `${seconds} seconds ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute(s) ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour(s) ago`;

    const days = Math.floor(hours / 24);
    return `${days} day(s) ago`;
  }
}
