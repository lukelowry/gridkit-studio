import * as vscode from 'vscode'

import { browser } from '../platform/host.js'

export const reference = (uri: vscode.Uri) =>
  !browser && uri.scheme === 'file' ? uri.fsPath : uri.toString()
export const uriOf = (path: string) =>
  /^[a-z][\w+.-]+:/i.test(path) ? vscode.Uri.parse(path) : vscode.Uri.file(path)
