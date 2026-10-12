/** The names GridKit Studio contributes in its manifest, and the files it reads, in one place: the
 *  manifest's own test holds them to package.json. */

/** What every contributed name starts with. */
export const PREFIX = 'gridkitStudio'

/** Every command Studio contributes, by its name after the prefix. */
export const COMMANDS = [
  'openCase',
  'openNetwork',
  'reveal',
  'openDiagram',
  'revealDiagram',
  'openCasePanel',
  'showInCase',
  'openMonitor',
  'showSource',
  'elementSource',
  'validateCase',
  'followReference',
  'editField',
  'copyReference',
  'copyValue',
  'chooseSignals',
  'selectAllSignals',
  'clearSignals',
  'runSimulation',
  'showResults',
  'runAgain',
  'stopSimulation',
  'clearResults',
  'plot',
  'removePlot',
  'signalElements',
  'openResults',
  'exportCsv',
  'showOutput',
  'performance',
  'toggleTimeline',
  'seekTime',
  'previousSample',
  'nextSample',
  'followTime',
  'loopTime',
  'timeSpeed',
  'fit',
  'neighborhood',
  'orbit',
  'retryMonitor',
  'resetMonitorWindow',
  'monitorWindow',
  'chooseOverlapping',
  'chooseType',
  'filterRows',
  'addPlot',
  'chooseColumns',
  'resetColumns',
  'sortAscending',
  'sortDescending',
  'clearSort',
  'filterValue',
  'clearFilter',
  'hideColumn',
  'copyFieldPath',
  'fromEndpoint',
  'toEndpoint',
  'projection',
  'bind',
  'mapRange',
  'unbind',
  'signalRange',
  'colormap',
  'networkSettings',
  'diagramSettings',
  'monitorSettings',
  'reviewChanges',
  'editDiagram',
  'finishDiagramEditing',
  'arrangeDiagram',
  'reloadView',
  'disconnectPort',
  'deleteDiagramElement',
  'exportVideo',
] as const
export type Command = (typeof COMMANDS)[number]

/** The commands a webview runs itself. */
export type ViewCommandName = Extract<Command, 'elementSource' | 'removePlot' | 'chooseSignals'>
export const VIEW_COMMANDS: readonly ViewCommandName[] = [
  'elementSource',
  'removePlot',
  'chooseSignals',
]

/** The views Studio contributes: its two canvas editors, its three webview panels, and Monitored
 *  Signals. */
export const VIEWS = ['network', 'diagram', 'case', 'monitor', 'export', 'signals'] as const
export type View = (typeof VIEWS)[number]

/** The context keys Studio sets, which its manifest's `when` clauses read. */
export const CONTEXT_KEYS = [
  'hasCase',
  'diagramEditing',
  'editable',
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

/** The view a contributed id names, if it names one of Studio's. */
export function viewOf(id: string): View | undefined {
  const name = id.startsWith(PREFIX + '.') ? id.slice(PREFIX.length + 1) : ''
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : undefined
}

/** A GridKit case, by its file's name. */
export const CASE_FILE = /\.case\.json$/i
/** The same, as a glob for document selectors. */
export const CASE_GLOB = '**/*.case.json'
/** Whether the views follow the case at `uri`, and Studio saves what they show of it: a case file
 *  on disk, never a copy another extension shows, as Git does of an older version. */
export const followed = (uri: string) => uri.startsWith('file:') && CASE_FILE.test(uri)
/** A GridKit solver file, by its name. */
export const SOLVER_FILE = /\.solver\.json$/i

/** The key a case's saved state is kept under in the workspace's state. */
const SAVED = 'case:'
export const savedKey = (uri: string) => SAVED + uri
/** The case a saved state's key names, if it names one. */
export const savedUri = (key: string) =>
  key.startsWith(SAVED) ? key.slice(SAVED.length) : undefined
