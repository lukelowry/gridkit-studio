import { URI } from 'vscode-uri'

/** Every name Studio contributes in its manifest, checked against package.json by the manifest
 *  test, plus the case file pattern. */

export const EXTENSION = 'lukelowery.gridkit-studio'

export const PREFIX = 'gridkitStudio'

/** Every contributed command, without the prefix. */
export const COMMANDS = [
  'openCase',
  'openNetwork',
  'revealInNetwork',
  'openCasePanel',
  'revealInCasePanel',
  'openMonitor',
  'revealInMonitor',
  'showJson',
  'copyId',
  'copyValue',
  'copyFieldPath',
  'runSimulation',
  'stopSimulation',
  'clearResults',
  'newMonitor',
  'splitMonitor',
  'unsplitMonitor',
  'previousMonitor',
  'nextMonitor',
  'chooseElement',
  'openResults',
  'exportCsv',
  'showOutput',
  'playPause',
  'goToTime',
  'previousSample',
  'nextSample',
  'goToEnd',
  'playbackSpeed',
  'fitAll',
  'reloadView',
  'timeWindow',
  'valueRange',
  'chooseType',
  'filterRows',
  'chooseColumns',
  'resetColumns',
  'sortAscending',
  'sortDescending',
  'clearSort',
  'filterToValue',
  'clearFilter',
  'hideColumn',
  'mapTo',
  'mappingRange',
  'removeMapping',
  'networkSettings',
  'monitorSettings',
  'exportSettings',
  'exportVideo',
  'exportImage',
] as const
export type Command = (typeof COMMANDS)[number]

/** The Network editor and the three webview panels. */
export const VIEWS = ['network', 'case', 'monitor', 'export'] as const
export type View = (typeof VIEWS)[number]

/** The context keys Studio sets for the manifest's `when` clauses. */
export const CONTEXT_KEYS = [
  'hasCase',
  'running',
  'hasResults',
  'hasSamples',
  'hasSelection',
  'caseReady',
  'caseFiltered',
  /** The Monitor has a monitor it does not show. */
  'canSplit',
] as const
export type ContextKey = (typeof CONTEXT_KEYS)[number]

export const commandId = (name: Command) => `${PREFIX}.${name}` as const
export const viewId = (view: View) => `${PREFIX}.${view}` as const
export const contextKey = (key: ContextKey) => `${PREFIX}.${key}` as const
export const settingsOf = (category: string) => `${PREFIX}.${category}` as const

export const CASE_FILE = /\.case\.json$/i
const SOLVER_FILE = /\.solver\.json$/i
/** Saved files whose path matches `pattern`, virtual workspaces included. Git previews and untitled
 *  copies are not. */
const savedAs = (uri: string, pattern: RegExp) => {
  const file = URI.parse(uri)
  return !!file.scheme && !['git', 'untitled'].includes(file.scheme) && pattern.test(file.path)
}
export const isCaseFile = (uri: string) => savedAs(uri, CASE_FILE)
export const isSolverFile = (uri: string) => savedAs(uri, SOLVER_FILE)

/** The workspace state key prefix for a case's saved state. */
const SAVED = 'case:'
export const savedKey = (uri: string) => SAVED + uri
export const savedUri = (key: string) =>
  key.startsWith(SAVED) ? key.slice(SAVED.length) : undefined
