interface FileSystemCreateSyncAccessHandleOptions {
  mode?: 'readwrite' | 'read-only' | 'readwrite-unsafe'
}
interface FileSystemFileHandle {
  createSyncAccessHandle(
    options?: FileSystemCreateSyncAccessHandleOptions,
  ): Promise<FileSystemSyncAccessHandle>
  move(destination: FileSystemDirectoryHandle, name: string): Promise<void>
}
