export const BRIDGE_FRAME_ATTRIBUTE = "data-tmd-bridge";
export const BRIDGE_READY_ATTRIBUTE = "data-tmd-bridge-ready";
export const BRIDGE_MESSAGE_PREFIX = "tmd:bridge:";
export const WRITER_CHANNEL_NAME = "telegram-media-downloader-writer";

export type BridgeStatus = {
  folderName: string | null;
  permission: PermissionState | "missing" | "unsupported";
  concurrency: number;
};

export type BridgeRequest = {
  source: "telegram-media-downloader";
  type: string;
  requestId: string;
  payload?: Record<string, unknown>;
};

export type BridgeResponse = {
  source: "telegram-media-downloader-bridge";
  type: string;
  requestId?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: string;
};

export type WriterControlRequest = {
  source: "telegram-media-downloader-popup";
  type: "directory:activate" | "directory:status";
  requestId: string;
  handle?: FileSystemDirectoryHandle;
};

export type WriterControlResponse = {
  source: "telegram-media-downloader-writer";
  type: "directory:activate:response" | "directory:status:response";
  requestId: string;
  ok: boolean;
  payload?: {
    folderName: string | null;
    permission: PermissionState | "missing";
  };
  error?: string;
};
