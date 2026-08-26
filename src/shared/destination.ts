const DB_NAME = "telegram-media-downloader";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DIRECTORY_KEY = "download-directory";

export type DirectoryPermission = PermissionState | "missing" | "unsupported";

export type DestinationStatus = {
  name: string | null;
  permission: DirectoryPermission;
};

type PermissionDescriptor = { mode: "read" | "readwrite" };
type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
};

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开下载目录数据库"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("下载目录数据库操作失败"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("下载目录数据库事务失败"));
    };
  });
}

export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await withStore<FileSystemDirectoryHandle | undefined>("readonly", (store) => store.get(DIRECTORY_KEY))) ?? null;
}

export async function setDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(handle, DIRECTORY_KEY));
}

export async function queryDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const permissionHandle = handle as PermissionDirectoryHandle;
  if (typeof permissionHandle.queryPermission !== "function") return "prompt";
  return permissionHandle.queryPermission({ mode: "readwrite" });
}

export async function requestDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const permissionHandle = handle as PermissionDirectoryHandle;
  if (typeof permissionHandle.requestPermission !== "function") return "denied";
  return permissionHandle.requestPermission({ mode: "readwrite" });
}

export async function chooseDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前 Chrome 版本不支持目录选择");
  const handle = await picker({ id: "telegram-media-downloads", mode: "readwrite" });
  await setDirectoryHandle(handle);
  return handle;
}

export async function getDestinationStatus(): Promise<DestinationStatus> {
  if (!(window as PickerWindow).showDirectoryPicker && typeof FileSystemDirectoryHandle === "undefined") {
    return { name: null, permission: "unsupported" };
  }
  const handle = await getDirectoryHandle();
  if (!handle) return { name: null, permission: "missing" };
  return { name: handle.name, permission: await queryDirectoryPermission(handle) };
}

