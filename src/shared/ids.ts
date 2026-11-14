import { URI } from 'vscode-uri'

/** The names GridKit Studio contributes in its manifest, and the files it reads, in one place: the
 *  manifest's own test holds them to package.json. */

/** What every contributed name starts with. */
export const PREFIX = 'gridkitStudio'

/** Every command Studio contributes, by its name after the prefix. */
export const COMMANDS = [
  'openCase',
  'openNetwork',
  'revealInNetwork',
  'openCasePanel',
  'revealInCase',
  'openMonitor',
  'openSource',
  'revealInSource',
  'goToReference',
  'copyId',
  'copyValue',
  'copyFieldPath',
  'runSimulation',
  'showLastResults',
  'runSimulationAgain',
  'stopSimulation',
  'clearResults',
  'plotSignal',
  'addPlot',
  'removePlot',
  'choosePlotElement',
  'openResults',
  'exportCsv',
  'showOutput',
  'playPause',
  'goToTime',
  'previousSample',
  'nextSample',
  'goToEnd',
  'playbackSpeed',
  'fit',
  'zoomToNeighborhood',
  'reloadView',
  'timeWindow',
  'valueRange',
  'selectOverlapping',
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
  'exportVideo',
  'exportImage',
] as const
export type Command = (typeof COMMANDS)[number]

/** The views Studio contributes: the Network editor, its three webview panels, and Monitored
 *  Signals. */
export const VIEWS = ['network', 'case', 'monitor', 'export', 'signals'] as const
export type View = (typeof VIEWS)[number]

/** The context keys Studio sets, which its manifest's `when` clauses read. */
export const CONTEXT_KEYS = [
  'hasCase',
  'running',
  'fromSolver',
  'hasResults',
  'hasSamples',
  'hasSelection',
  'caseReady',
  'caseFiltered',
] as const
export type ContextKey = (typeof CONTEXT_KEYS)[number]

export const commandId = (name: Command) => `${PREFIX}.${name}` as const
export const viewId = (view: View) => `${PREFIX}.${view}` as const
export const contextKey = (key: ContextKey) => `${PREFIX}.${key}` as const
/** The settings of `category`, as the Settings editor searches for them. */
export const settingsOf = (category: string) => `${PREFIX}.${category}` as const

/** A GridKit case, by its file's name. */
export const CASE_FILE = /\.case\.json$/i
/** Saved case files, including virtual workspaces; Git previews and untitled copies stay separate. */
export const followed = (uri: string) => {
  const file = URI.parse(uri)
  return !!file.scheme && !['git', 'untitled'].includes(file.scheme) && CASE_FILE.test(file.path)
}

/** The key a case's saved state is kept under in the workspace's state. */
const SAVED = 'case:'
export const savedKey = (uri: string) => SAVED + uri
/** The case a saved state's key names, if it names one. */
export const savedUri = (key: string) =>
  key.startsWith(SAVED) ? key.slice(SAVED.length) : undefined
