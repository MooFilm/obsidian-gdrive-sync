/**
 * Google Drive REST API v3 wrapper.
 * Uses Obsidian's requestUrl() for cross-platform HTTP requests.
 */

import { requestUrl, RequestUrlResponse } from "obsidian";
import { GoogleAuth } from "./auth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  trashed?: boolean;
  parents?: string[];
}

export interface DriveChange {
  fileId: string;
  file?: DriveFile;
  removed: boolean;
  time: string;
}

export interface ChangesResult {
  changes: DriveChange[];
  newPageToken: string;
}

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export class DriveAPI {
  private auth: GoogleAuth;

  constructor(auth: GoogleAuth) {
    this.auth = auth;
  }

  /**
   * Make an authenticated request, auto-refreshing on 401.
   */
  private async request(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
      contentType?: string;
    } = {},
    retried = false
  ): Promise<RequestUrlResponse> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };

    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }

    try {
      const response = await requestUrl({
        url,
        method: options.method || "GET",
        headers,
        body: options.body,
        throw: false,
      });

      if (response.status === 401 && !retried) {
        // Token expired — refresh and retry once
        await this.auth.refreshAccessToken();
        return this.request(url, options, true);
      }

      if (response.status >= 400) {
        let errorMessage = `Drive API error ${response.status}`;
        try {
          const errorBody = response.json;
          if (errorBody?.error?.message) {
            errorMessage += `: ${errorBody.error.message}`;
          }
        } catch {
          // Response might not be JSON
        }
        throw new Error(errorMessage);
      }

      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Drive API error")) {
        throw err;
      }
      // Network error
      throw new Error(
        `Network error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Upload or update a file on Google Drive using multipart upload.
   * Returns the Drive file ID.
   */
  async uploadFile(
    localPath: string,
    content: string,
    mimeType: string,
    existingFileId?: string,
    parentFolderId?: string
  ): Promise<string> {
    const metadata: Record<string, unknown> = {
      name: localPath,
      mimeType: mimeType,
    };

    if (!existingFileId && parentFolderId) {
      metadata.parents = [parentFolderId];
    }

    const boundary = "gdrive_sync_boundary_" + Date.now();
    const delimiter = `--${boundary}`;
    const closeDelimiter = `--${boundary}--`;

    const multipartBody =
      `${delimiter}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `${delimiter}\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n` +
      `${content}\r\n` +
      `${closeDelimiter}`;

    let url: string;
    let method: string;

    if (existingFileId) {
      // Update existing file
      url = `${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=multipart&fields=id,name,modifiedTime`;
      method = "PATCH";
    } else {
      // Create new file
      url = `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime`;
      method = "POST";
    }

    const response = await this.request(url, {
      method,
      contentType: `multipart/related; boundary=${boundary}`,
      body: multipartBody,
    });

    const result = response.json;
    return result.id as string;
  }

  /**
   * Download file content from Google Drive.
   */
  async downloadFile(fileId: string): Promise<string> {
    const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;
    const response = await this.request(url);
    return response.text;
  }

  /**
   * Get file metadata from Google Drive.
   */
  async getFileMetadata(fileId: string): Promise<DriveFile> {
    const url = `${DRIVE_API_BASE}/files/${fileId}?fields=id,name,mimeType,modifiedTime,trashed,parents`;
    const response = await this.request(url);
    return response.json as DriveFile;
  }

  /**
   * Get changes since the given page token.
   */
  async getChanges(pageToken: string): Promise<ChangesResult> {
    const params = new URLSearchParams({
      pageToken,
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(id,name,mimeType,modifiedTime,trashed,parents))",
      spaces: "drive",
      includeRemoved: "true",
      pageSize: "100",
    });

    const url = `${DRIVE_API_BASE}/changes?${params.toString()}`;
    const response = await this.request(url);
    const json = response.json;

    const changes: DriveChange[] = (
      json.changes as Array<Record<string, unknown>>
    ).map((c) => ({
      fileId: c.fileId as string,
      file: c.file as DriveFile | undefined,
      removed: (c.removed as boolean) || false,
      time: (c.time as string) || "",
    }));

    // Use newStartPageToken if available (end of current changes), else nextPageToken for pagination
    const newPageToken =
      (json.newStartPageToken as string) || (json.nextPageToken as string) || pageToken;

    return { changes, newPageToken };
  }

  /**
   * Get the initial start page token for change tracking.
   */
  async getStartPageToken(): Promise<string> {
    const url = `${DRIVE_API_BASE}/changes/startPageToken`;
    const response = await this.request(url);
    return response.json.startPageToken as string;
  }

  /**
   * Create a folder on Google Drive. Returns the folder ID.
   */
  async createFolder(name: string, parentId?: string): Promise<string> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType: "application/vnd.google-apps.folder",
    };

    if (parentId) {
      metadata.parents = [parentId];
    }

    const response = await this.request(
      `${DRIVE_API_BASE}/files?fields=id,name`,
      {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify(metadata),
      }
    );

    return response.json.id as string;
  }

  /**
   * Find a folder by name in Drive root (or specified parent).
   * Returns the folder ID if found, null otherwise.
   */
  async findFolder(name: string, parentId?: string): Promise<string | null> {
    const parentClause = parentId
      ? `'${parentId}' in parents`
      : "'root' in parents";
    const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and ${parentClause} and trashed=false`;

    const params = new URLSearchParams({
      q: query,
      fields: "files(id,name)",
      pageSize: "1",
    });

    const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
    const response = await this.request(url);
    const files = response.json.files as Array<{ id: string }>;

    return files.length > 0 ? files[0].id : null;
  }

  /**
   * Ensure a folder exists, creating it if necessary. Returns the folder ID.
   */
  async ensureFolder(name: string): Promise<string> {
    const existing = await this.findFolder(name);
    if (existing) return existing;
    return this.createFolder(name);
  }

  /**
   * Move a file to Drive trash (soft delete).
   */
  async trashFile(fileId: string): Promise<void> {
    const url = `${DRIVE_API_BASE}/files/${fileId}`;
    await this.request(url, {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  /**
   * List all files in a folder (non-recursive, non-trashed).
   */
  async listFilesInFolder(
    folderId: string,
    pageToken?: string
  ): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents)",
      pageSize: "100",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
    const response = await this.request(url);
    const json = response.json;

    return {
      files: json.files as DriveFile[],
      nextPageToken: json.nextPageToken as string | undefined,
    };
  }

  /**
   * Recursively list all files under a folder.
   */
  async listAllFilesRecursive(folderId: string): Promise<DriveFile[]> {
    const allFiles: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const result = await this.listFilesInFolder(folderId, pageToken);

      for (const file of result.files) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          // Recurse into subfolder
          const subFiles = await this.listAllFilesRecursive(file.id);
          allFiles.push(...subFiles);
        } else {
          allFiles.push(file);
        }
      }

      pageToken = result.nextPageToken;
    } while (pageToken);

    return allFiles;
  }
}
