/**
 * OAuth 2.0 PKCE authentication for Google Drive.
 * Works on both desktop (localhost redirect) and mobile (manual code entry).
 */

import { Notice, Platform } from "obsidian";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in ms
  token_type: string;
  scope: string;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  loadData: () => Promise<Record<string, unknown>>;
  saveData: (data: Record<string, unknown>) => Promise<void>;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const REDIRECT_URI_DESKTOP = "http://localhost:42813/callback";
const REDIRECT_URI_MOBILE = "urn:ietf:wg:oauth:2.0:oob";

/**
 * Generate a cryptographically random string using Web Crypto API.
 */
function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/**
 * Create a SHA-256 hash and return as base64url-encoded string (for PKCE).
 */
async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hash);
  let binary = "";
  hashArray.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class GoogleAuth {
  private config: AuthConfig;
  private tokenData: TokenData | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private codeVerifier: string = "";

  constructor(config: AuthConfig) {
    this.config = config;
  }

  /**
   * Initialize auth — load saved tokens from plugin data.
   */
  async initialize(): Promise<void> {
    const data = await this.config.loadData();
    if (data && data["tokenData"]) {
      this.tokenData = data["tokenData"] as TokenData;
      this.scheduleRefresh();
    }
  }

  /**
   * Check if we have valid (or refreshable) tokens.
   */
  isAuthenticated(): boolean {
    return this.tokenData !== null && !!this.tokenData.refresh_token;
  }

  /**
   * Get a valid access token, refreshing if needed.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokenData) {
      throw new Error("Not authenticated. Please connect Google Drive first.");
    }

    // Refresh if token expires within the next 60 seconds
    if (Date.now() >= this.tokenData.expires_at - 60_000) {
      await this.refreshAccessToken();
    }

    return this.tokenData.access_token;
  }

  /**
   * Start the OAuth 2.0 PKCE flow.
   */
  async startAuthFlow(): Promise<void> {
    if (!this.config.clientId) {
      new Notice("Please set your Google OAuth Client ID in settings first.");
      return;
    }

    this.codeVerifier = generateRandomString(64);
    const codeChallenge = await sha256Base64Url(this.codeVerifier);
    const state = generateRandomString(16);

    const isMobile = Platform.isMobile;
    const redirectUri = isMobile ? REDIRECT_URI_MOBILE : REDIRECT_URI_DESKTOP;

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: state,
      access_type: "offline",
      prompt: "consent",
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

    if (isMobile) {
      // On mobile, open URL and ask user to paste the code
      window.open(authUrl);
      new Notice(
        "A browser window has opened. After authorizing, copy the code and paste it in the prompt.",
        10000
      );
      // We'll handle the code via a modal prompt triggered from settings
      // Store the verifier so exchangeCodeForTokens can use it later
      const data = await this.config.loadData();
      await this.config.saveData({
        ...data,
        pendingCodeVerifier: this.codeVerifier,
        pendingRedirectUri: redirectUri,
      });
    } else {
      // On desktop, start a tiny HTTP server to capture the redirect
      await this.startLocalServer(state);
      window.open(authUrl);
    }
  }

  /**
   * Exchange an authorization code for tokens (used on mobile after user pastes code).
   */
  async exchangeCodeManually(code: string): Promise<void> {
    const data = await this.config.loadData();
    const verifier = (data["pendingCodeVerifier"] as string) || this.codeVerifier;
    const redirectUri =
      (data["pendingRedirectUri"] as string) || REDIRECT_URI_MOBILE;

    await this.exchangeCodeForTokens(code, verifier, redirectUri);

    // Clean up pending data
    delete data["pendingCodeVerifier"];
    delete data["pendingRedirectUri"];
    await this.config.saveData(data);
  }

  /**
   * Start a local HTTP server on desktop to capture OAuth redirect.
   */
  private async startLocalServer(expectedState: string): Promise<void> {
    // Use Obsidian's requestUrl as fallback approach:
    // On desktop, we rely on the user being redirected to localhost.
    // Since we can't create a real HTTP server in a browser-platform plugin,
    // we'll use a polling approach instead.
    //
    // Store the verifier and wait for exchangeCodeManually to be called.
    // The settings tab will provide a text input for the auth code on all platforms.

    const data = await this.config.loadData();
    await this.config.saveData({
      ...data,
      pendingCodeVerifier: this.codeVerifier,
      pendingRedirectUri: REDIRECT_URI_DESKTOP,
      pendingState: expectedState,
    });

    new Notice(
      "Browser opened for Google authorization. After approving, you'll be redirected. " +
        "Copy the authorization code from the URL and paste it in plugin settings.",
      15000
    );
  }

  /**
   * Exchange authorization code for access + refresh tokens.
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    console.log("GDrive Sync: Token exchange params:", {
      client_id: this.config.clientId.substring(0, 20) + "...",
      client_secret: this.config.clientSecret ? this.config.clientSecret.substring(0, 10) + "..." : "EMPTY!",
      code: code.substring(0, 15) + "...",
      code_verifier: codeVerifier ? codeVerifier.substring(0, 10) + "..." : "EMPTY!",
      redirect_uri: redirectUri,
    });

    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      const json = await response.json();

      console.log("GDrive Sync: Token response status:", response.status, "body:", JSON.stringify(json));

      if (!response.ok || json.error) {
        const errorDetail = json.error_description || json.error || `Status ${response.status}`;
        new Notice(`❌ Auth failed: ${errorDetail}`, 10000);
        throw new Error(`Token exchange failed: ${errorDetail}`);
      }

      this.tokenData = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + json.expires_in * 1000,
        token_type: json.token_type,
        scope: json.scope,
      };

      await this.saveTokens();
      this.scheduleRefresh();

      new Notice("✅ Google Drive connected successfully!");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("Token exchange failed")) {
        new Notice(`❌ Auth failed: ${message}`, 10000);
      }
      throw err;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   */
  async refreshAccessToken(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      throw new Error("No refresh token available. Please re-authenticate.");
    }

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.tokenData.refresh_token,
      grant_type: "refresh_token",
    });

    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      const json = await response.json();

      if (!response.ok || json.error) {
        throw new Error(`Token refresh failed: ${json.error_description || json.error || response.statusText}`);
      }

      this.tokenData = {
        ...this.tokenData,
        access_token: json.access_token,
        expires_at: Date.now() + json.expires_in * 1000,
        token_type: json.token_type || this.tokenData.token_type,
        scope: json.scope || this.tokenData.scope,
      };

      // Google sometimes issues a new refresh token
      if (json.refresh_token) {
        this.tokenData.refresh_token = json.refresh_token;
      }

      await this.saveTokens();
      this.scheduleRefresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("GDrive Sync: Token refresh failed:", message);
      // If refresh fails, clear tokens so user re-authenticates
      if (message.includes("invalid_grant")) {
        this.tokenData = null;
        await this.saveTokens();
        new Notice("❌ Google Drive session expired. Please reconnect.");
      }
      throw err;
    }
  }

  /**
   * Schedule automatic token refresh before expiry.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.tokenData) return;

    // Refresh 5 minutes before expiry
    const refreshIn = Math.max(
      this.tokenData.expires_at - Date.now() - 5 * 60 * 1000,
      30_000 // At least 30 seconds from now
    );

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshAccessToken();
      } catch (err) {
        console.error("GDrive Sync: Scheduled token refresh failed:", err);
      }
    }, refreshIn);
  }

  /**
   * Save token data to plugin storage.
   */
  private async saveTokens(): Promise<void> {
    const data = await this.config.loadData();
    if (this.tokenData) {
      data["tokenData"] = this.tokenData as unknown as Record<string, unknown>;
    } else {
      delete data["tokenData"];
    }
    await this.config.saveData(data);
  }

  /**
   * Disconnect — clear all tokens.
   */
  async disconnect(): Promise<void> {
    this.tokenData = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.saveTokens();
    new Notice("Google Drive disconnected.");
  }

  /**
   * Clean up timers on plugin unload.
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
