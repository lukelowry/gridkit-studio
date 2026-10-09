# Running GridKit from solver files

Studio runs GridKit the way a shell does. Right-click `IEEE39.solver.json`, choose Run Dynamic Simulation, and Studio runs `DynamicSimulation IEEE39.solver.json` in that file's folder, on the files as saved. Nothing else in Studio starts GridKit.

Studio holds no run configuration of its own. Everything a run does is written in GridKit's two files. Studio's views only read and edit them, and every results file Studio shows is read the same way.

| What | Where it lives | What edits it in Studio |
|---|---|---|
| The program | the menu item chosen | |
| Options, events and faults | the `.solver.json` | the JSON editor |
| The case | the solver file's `system_model_file` | Network, Diagram, Case panel |
| What a run records | each element's `mon` list in the case | Monitored Signals |
| Where the samples go | the case's monitor, else the solver file's `output_file` | the JSON editor |
| What a results file holds | its header | |
| The samples | that file, as GridKit writes it | the Monitor reads it |

## Three readers

Studio understands GridKit's files through three small readers, and nothing else in Studio looks inside them.

1. **The solver file**, in `shared/study.ts`. It reads the case a solver file names, its `tmax` for progress, and its `output_file`. GridKit reads the rest, so an option, an event type like the branch switching in ORNL/GridKit#610, or a fault format like the one in #611 needs no Studio change.
2. **The case's recording**, in `gridkit/recording.ts`. It reads which outputs each element's `mon` list names and where the case's monitor writes, and it edits the `mon` lists for Monitored Signals.
3. **A results file**, in `results/`. Its header says what it holds. A run being written, a file opened with Open Results…, a file read again after a reload and a study's other contingency are all read by that one path.

## What this revision fixes

The last version still had loose ends. Each was a place where Studio did one thing two ways, or second-guessed GridKit.

- **Two ways to learn what a file holds.** A run took its fields from the case's `mon` lists. An opened file took them from its header, in a separate pass over the file. Now every file is read by its header, inside the one pass that already reads it. `gridkit/parameters.ts` and `results/selection.ts` go entirely.
- **The solver file read in two processes.** The extension read `system_model_file`, then the worker read `tmax` and `output_file` again. Now one pure reader reads it once, in the extension. The worker never opens a solver file. It's told what to run and where the output is.
- **Studio still gated runs on its own validation.** The worker refused a case with errors in Studio's diagnostics. Studio's catalog can lag GridKit, so that check could block a run GridKit would accept. GridKit checks its own input now. Studio only needs to read the case, since the Monitor decodes against it. Studio's issues still show in Problems.
- **Stale files were removed too broadly, and unsafely.** A study removed one file per bus whether it existed or not. A simulation would have removed a study's files it never writes. An `output_file` naming the case would have deleted the case. Now a run removes only what its program is about to write over, found with one `readdir`. Studio also refuses an output that names the solver file or its case.
- **Restoring raced a run.** A reload's restore and a new run could both claim the Monitor, and `open` broadcast its result to every view. Now `open` answers only its caller, and a restore shows only when nothing else has.
- **A separate request and an async refresh for Monitored Signals.** The counts now come with the case's summary, beside the case's monitor, as `Summary.recording`. The tree reads the summary like every other view.
- **A class wrapped around one function.** `Simulation`, `prepare` and the worker's `runCase` become one `simulate()`, which the worker and the real-GridKit suite both call.
- **Contingencies tracked by bus name.** The picker lists the contingencies that wrote a file, found when the study ends. GridKit's failure names are kept only for the notice that says how many failed.

## What goes

Roughly 2,500 lines go and 350 come in, by my count, before the run tests are rewritten.

**Running**
- The Simulation view, its form, the form's model in `shared/parameters.ts`, and the catalog's `options`.
- `gridkit/parameters.ts` in full. `Field` moves to `results/decode.ts`, which builds fields from a header.
- The task provider and its launch bookkeeping, `tasks.ts`.
- Staging, `staging.ts`. There is no case copy, no `mon` rewrite, no sink rewrite and no `input.json`.
- Preflight, `preflight.ts`, and the worker's validation gate.
- The start and stop protocol: `prepareSimulation`, `stopSimulation`, `stop`, `simulationId`, `Session.launching` and the `preparing` state. One `run` call is the run, and cancelling it stops the run.
- The `Simulation` class and `worker/simulations.ts`.
- `SimulationInfo.configuration` and the `PROGRAMS` labels. The log names a run by what a shell would run.
- The `elements` request, which only the form's bus picker used.

**Recording**
- `results/storage.ts`, with its manifests, snapshots, ownership across windows, disk budget and eviction.
- `results/scratch.ts` and the worker's scratch folder.
- `results/study.ts`, the contingency loader that shared a recording folder.
- `results/selection.ts`. Its name matching becomes how a header is read.
- `Results.ownedDirectory` and `dispose`, plus the worker's `owners`, `discard`, `trimRecordings`, `ensureRecordingsReady`, `loading`, `getSimulation` and the recording branch of `loadResult`.
- The `resultStorageMiB` setting, and `evicted` and `retained` on `SimulationInfo`.
- Session state that stood in for the files: `values`, `outputs`, `defaultOutputs()`, `record()`, and `previous`, which nothing read.
- Map To… adding a mapped field to future recordings. That would now be a hidden edit to the case.

**Commands**
- Start Simulation, Configure Fault…, Where GridKit Runs, and the `showContingency` webview command.
- Import Results… becomes Open Results…, which makes the same `open` request a reload makes.

## How a run behaves

**Saving.** GridKit reads the files as saved, so Studio saves the solver file and its case first when either has unsaved edits. VS Code's own tasks save before they run too.

**Where the output is.** Studio follows GridKit's rule in `parseStudyData`. The case's monitor wins, and the solver file's `output_file` is used when the case has none. Studio reads a CSV or an Arrow monitor. Paths are relative to the solver file's folder, where GridKit runs. A solver file with no `output_file` whose case has no monitor would write nothing to show, so Studio says that instead of running. So does a case whose elements record nothing, with an offer to open Monitored Signals.

**Writing over the last run.** Studio reads what GridKit writes, so a run first removes what its program is about to write over. For a simulation that's the output file. For a study it's the `<stem>_<n><ext>` files beside the solver file. GridKit would write over them anyway, and none of them can then pass for this run's.

**Reading the output.** A DynamicSimulation is read while GridKit writes it, from its header on. GridKit writes a column for each output an element's `mon` list names, and Studio matches columns to the case by name. So any lists the user wrote read correctly, and a file another tool wrote reads the same way.

**Monitored Signals.** The tree shows the case's `mon` lists. Checking Bus › Vm makes every bus list `Vm`, as one edit to the case that undo reverses. A field only some elements list shows how many do. Nothing is recorded that the case doesn't list.

**Contingency analysis.** ContingencyAnalysis writes `<stem>_<n><ext>` for the case's `n`th bus. GridKit builds that name from `path.stem()`, which drops the output's folder, so the files land in the solver file's folder. When the study ends, Studio lists the files it wrote and shows the first. Show Contingency… in the Monitor's title opens another. GridKit runs contingencies at once, so the notification doesn't count them.

**Containers.** An installed GridKit runs with the solver file's folder as its working directory. A container mounts the solver file's workspace folder and works in the solver file's folder inside it. A case or output outside that workspace folder is out of the container's sight, so Studio says so before starting.

**After a reload.** The session remembers the file the Monitor showed and reads it again when the case first opens. A file that is gone, or no longer matches the case, is forgotten. A run started in the meantime shows instead.

## File tree

`+` new, `−` removed, `~` changed, unmarked unchanged.

```
.
├─ package.json                      ~ run pair, Show Contingency, Open Results
│                                      − Simulation view, task definition, resultStorageMiB
├─ esbuild.mjs                       ~ − simulation webview entry
├─ assets/
│  ├─ borders.bin
│  ├─ gridkit.png
│  ├─ gridkit.svg
│  ├─ monitor.svg
│  └─ walkthrough.md                 ~ the simulate step runs a solver file
├─ docs/media/DESIGN.md                this file
├─ scripts/
│  ├─ cases.mjs                      ~ a plain copy at the image's GridKit ref
│  └─ settings.mjs
├─ cases/
│  ├─ ACTIVSg10k.case.json           ~ as GridKit has it at that ref
│  ├─ ACTIVSg10k.solver.json         +
│  ├─ ACTIVSg2000.case.json          ~
│  ├─ ACTIVSg2000.solver.json        +
│  ├─ IEEE39.case.json               ~
│  ├─ IEEE39.solver.json             +
│  ├─ TwoArea.case.json              ~
│  ├─ TwoArea.solver.json            +
│  ├─ TwoBusBasic.case.json          ~
│  ├─ TwoBusBasic.solver.json        +
│  ├─ WECC240.case.json              ~
│  └─ WECC240.solver.json            +
├─ src/
│  ├─ extension/
│  │  ├─ actions.ts
│  │  ├─ client.ts                   ~ − scratch folder, sweep, storage settings
│  │  ├─ commands.ts                 ~ − startSimulation, stopSimulation, showContingency, addFault,
│  │  │                                  simulationSettings, importResults
│  │  │                                + chooseContingency, openResults
│  │  ├─ documents.ts
│  │  ├─ git.ts
│  │  ├─ index.ts                    ~ registerRuns
│  │  ├─ manifest.test.ts            ~
│  │  ├─ navigation.ts
│  │  ├─ playback.ts
│  │  ├─ runs.ts                     + a solver file's menu → one run call → progress notification
│  │  ├─ sessions.ts                 ~ − values, launching, outputs, previous, record()
│  │  │                                + restore by reading the saved file, the contingency context
│  │  │                                  key, cacheBytesOf() from tasks.ts
│  │  ├─ signals.ts                  ~ reads Summary.recording, edits the case's mon lists
│  │  ├─ stream.test.ts
│  │  ├─ stream.ts
│  │  ├─ tasks.ts                    −
│  │  ├─ video.ts
│  │  └─ views.ts                    ~ − the simulation view kind, the elements request
│  ├─ gridkit/
│  │  ├─ case.test.ts                ~ − parametersOf, selections
│  │  ├─ case.ts
│  │  ├─ cases.test.ts               ~ − the BusFault check
│  │  ├─ catalog.json                ~ − options
│  │  ├─ columns.ts
│  │  ├─ create.test.ts
│  │  ├─ create.ts                   ~ realText from edits.ts
│  │  ├─ definition.ts               ~ − OptionSpec, Catalog.options
│  │  ├─ edits.ts                    ~ + realText, moved from staging.ts
│  │  ├─ index.ts                    ~
│  │  ├─ inspection.test.ts
│  │  ├─ inspection.ts
│  │  ├─ navigation.ts
│  │  ├─ parameters.ts               −
│  │  ├─ parse.ts
│  │  ├─ plan.ts                     ~ + the record mutation
│  │  ├─ preflight.ts                −
│  │  ├─ recording.test.ts           +
│  │  ├─ recording.ts                + the case's mon lists and monitor, read, and the lists edited
│  │  ├─ runtime.test.ts             ~
│  │  ├─ runtime.ts                  ~ runs in the solver file's folder, mounts the workspace folder
│  │  ├─ simulation.ts               ~ simulate(): launch, then read what GridKit writes
│  │  ├─ solver.test.ts
│  │  ├─ solver.ts
│  │  ├─ staging.ts                  −
│  │  ├─ transactions.test.ts        ~ the record mutation
│  │  └─ transactions.ts
│  ├─ results/
│  │  ├─ arrow.ts
│  │  ├─ csv.test.ts
│  │  ├─ csv.ts
│  │  ├─ decode.ts                   ~ Field, and a header read into fields and their columns
│  │  ├─ index.ts                    ~
│  │  ├─ limits.ts
│  │  ├─ readers.ts
│  │  ├─ results.test.ts             ~
│  │  ├─ results.ts                  ~ fields from the header, − ownedDirectory, dispose
│  │  ├─ scratch.test.ts             −
│  │  ├─ scratch.ts                  −
│  │  ├─ selection.ts                −
│  │  ├─ storage.test.ts             −
│  │  ├─ storage.ts                  −
│  │  └─ study.ts                    −
│  ├─ shared/
│  │  ├─ bindings.test.ts
│  │  ├─ bindings.ts
│  │  ├─ cells.test.ts
│  │  ├─ cells.ts
│  │  ├─ contexts.ts
│  │  ├─ coverage.test.ts
│  │  ├─ coverage.ts
│  │  ├─ errors.ts
│  │  ├─ format.test.ts
│  │  ├─ format.ts
│  │  ├─ messages.ts                 ~ run and open requests, Summary.recording, the record mutation
│  │  │                                − simulation view kind, Summary.parameters, values, launching,
│  │  │                                  prepare, stop, import, elements
│  │  ├─ pages.test.ts
│  │  ├─ pages.ts
│  │  ├─ parameters.test.ts          −
│  │  ├─ parameters.ts               −
│  │  ├─ positions.test.ts
│  │  ├─ positions.ts
│  │  ├─ preferences.ts
│  │  ├─ schema.ts
│  │  ├─ simulation.ts               ~ SimulationRequest names the solver file and its output
│  │  ├─ streams.test.ts
│  │  ├─ streams.ts
│  │  ├─ study.test.ts               +
│  │  ├─ study.ts                    + what Studio reads of a solver file
│  │  ├─ transport.test.ts
│  │  └─ transport.ts
│  ├─ webview/
│  │  ├─ bridge.ts
│  │  ├─ canvas.ts
│  │  ├─ case.ts
│  │  ├─ case/Case.svelte
│  │  ├─ clock.test.ts
│  │  ├─ clock.ts
│  │  ├─ diagram/
│  │  │  ├─ diagram.ts
│  │  │  ├─ edit.test.ts
│  │  │  ├─ edit.ts
│  │  │  ├─ labels.ts
│  │  │  ├─ options.ts
│  │  │  └─ style.ts
│  │  ├─ export.ts
│  │  ├─ export/
│  │  │  ├─ Export.svelte
│  │  │  └─ video.ts
│  │  ├─ gpu.ts
│  │  ├─ menu.ts
│  │  ├─ monitor.ts
│  │  ├─ monitor/
│  │  │  ├─ Monitor.svelte           ~ the empty state points at a solver file's menu
│  │  │  ├─ Plot.svelte
│  │  │  ├─ plot.test.ts
│  │  │  ├─ plot.ts
│  │  │  └─ recording.test.ts
│  │  ├─ network/
│  │  │  ├─ borders.ts
│  │  │  ├─ channels.ts
│  │  │  ├─ network.ts
│  │  │  ├─ options.test.ts
│  │  │  ├─ options.ts
│  │  │  ├─ style.test.ts
│  │  │  └─ style.ts
│  │  ├─ pages.test.ts
│  │  ├─ pages.ts
│  │  ├─ recovery.test.ts
│  │  ├─ recovery.ts
│  │  ├─ simulation.ts               −
│  │  ├─ simulation/                 −
│  │  │  ├─ Field.svelte             −
│  │  │  ├─ Form.svelte              −
│  │  │  ├─ Simulation.svelte        −
│  │  │  └─ rows.ts                  −
│  │  ├─ stream.test.ts
│  │  ├─ stream.ts
│  │  ├─ styles.d.ts
│  │  ├─ styles/
│  │  │  ├─ canvas.css
│  │  │  ├─ components.css
│  │  │  ├─ index.css
│  │  │  └─ tokens.css               ~ − the simulation page's selector
│  │  ├─ theme.ts
│  │  └─ ui/
│  │     ├─ CanvasHost.svelte
│  │     ├─ Icon.svelte
│  │     ├─ Section.svelte
│  │     ├─ Select.svelte
│  │     ├─ Switch.svelte
│  │     ├─ cursor.svelte.ts
│  │     ├─ glyphs.ts
│  │     ├─ listbox.test.ts
│  │     ├─ listbox.ts
│  │     ├─ typeahead.test.ts
│  │     ├─ typeahead.ts
│  │     ├─ viewport.svelte.ts
│  │     ├─ windowing.test.ts
│  │     └─ windowing.ts
│  ├─ worker.test.ts                 ~ − storage and import cases, + open
│  ├─ worker.ts                      ~ run and open
│  │                                   − storage, eviction, prepare, stop, import, elements, the
│  │                                     validation gate
│  └─ worker/
│     ├─ batches.test.ts
│     ├─ batches.ts
│     ├─ cases.test.ts               ~
│     ├─ cases.ts                    ~ Summary.recording, − Summary.parameters
│     └─ simulations.ts              −
├─ tests/
│  ├─ benchmarks/
│  │  ├─ compare.mjs
│  │  ├─ playback.ts                 ~ runs a solver file
│  │  ├─ scrub.ts                    ~
│  │  ├─ views.ts                    ~ − the Simulation view
│  │  └─ windowed-playback.ts        ~
│  ├─ menus.test.ts                  ~
│  ├─ menus.ts                       ~
│  ├─ simulation/simulation.test.ts  ~ simulate() on solver files in place, through Docker
│  └─ vscode/
│     ├─ appearance.test.ts          ~ − the Simulation view
│     ├─ case.test.ts
│     ├─ diagram.test.ts
│     ├─ export.test.ts
│     ├─ harness.ts                  ~ a temporary workspace of case and solver files
│     ├─ index.ts
│     ├─ launch.mjs
│     ├─ links.test.ts
│     ├─ menus.test.ts               ~
│     ├─ monitor.test.ts
│     ├─ native.test.ts
│     ├─ network.test.ts
│     ├─ package.mjs                 ~ − dist/webview/simulation.*
│     ├─ run.test.ts                 ~ runs from the solver file's menu
│     ├─ screenshots.ts              ~
│     ├─ sessions.test.ts            ~ the saved results file
│     ├─ simulation.test.ts          −
│     ├─ source.test.ts
│     ├─ suites.ts                   ~
│     ├─ trust.ts
│     ├─ video.test.ts
│     ├─ wecc.test.ts                ~
│     └─ workflows.test.ts           ~ Monitored Signals edits the case
└─ vitest.config.ts
```

## Code

### package.json

```jsonc
"commands": [
  // − startSimulation, addFault, simulationSettings, importResults
  { "command": "gridkitStudio.runSimulation", "title": "Run Dynamic Simulation",
    "category": "GridKit Studio", "enablement": "isWorkspaceTrusted" },
  { "command": "gridkitStudio.runContingencies", "title": "Run Contingency Analysis",
    "category": "GridKit Studio", "enablement": "isWorkspaceTrusted" },
  { "command": "gridkitStudio.chooseContingency", "title": "Show Contingency…",
    "category": "GridKit Studio", "icon": "$(list-selection)", "enablement": "gridkitStudio.contingency" },
  { "command": "gridkitStudio.openResults", "title": "Open Results…",
    "category": "GridKit Studio", "icon": "$(folder-opened)", "enablement": "gridkitStudio.hasCase" }
],
"menus": {
  // The same pair goes in editor/context and editor/title/context.
  "explorer/context": [
    { "command": "gridkitStudio.runSimulation",    "when": "resourceFilename =~ /\\.solver\\.json$/i", "group": "gridkit@0" },
    { "command": "gridkitStudio.runContingencies", "when": "resourceFilename =~ /\\.solver\\.json$/i", "group": "gridkit@1" }
  ],
  "view/title": [
    // − the three gridkitStudio.simulation entries, and importResults becomes openResults
    { "command": "gridkitStudio.stopSimulation",    "when": "view == gridkitStudio.monitor && gridkitStudio.running",     "group": "navigation@0" },
    { "command": "gridkitStudio.chooseContingency", "when": "view == gridkitStudio.monitor && gridkitStudio.contingency", "group": "navigation@2" }
  ],
  // webview/context: − addFault
  "commandPalette": [
    // GridKit runs only on the file a menu was opened on.
    { "command": "gridkitStudio.runSimulation", "when": "false" },
    { "command": "gridkitStudio.runContingencies", "when": "false" }
  ]
},
"views": { "gridkitStudio": [ { "id": "gridkitStudio.signals", … }, { "id": "gridkitStudio.export", … } ] }
// − "taskDefinitions", − "gridkitStudio.resultStorageMiB"
// The walkthrough's simulate step completes on onCommand:gridkitStudio.runSimulation.
```

### src/shared/study.ts (new)

```ts
/** What Studio reads of a GridKit study's files. GridKit reads everything else in them, so an
 *  option, event or fault format it adds needs nothing here. */

import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'

/** What a .solver.json says that Studio uses: the case it runs, when it ends, and the file it
 *  names for its samples, if any. Paths are as written, relative to the solver file's folder. */
export interface Solver {
  readonly model: string
  readonly tmax: number
  readonly output?: string
}

/** A file GridKit writes samples to, and how. */
export interface Sink {
  readonly file: string
  readonly format: 'csv' | 'arrow'
}

/** The solver file `name` read from its `text`, or why it can't run. */
export function readSolver(name: string, text: string): Solver {
  const errors: ParseError[] = []
  const json = parse(text, errors, { disallowComments: true, allowTrailingComma: false }) as Record<
    string,
    unknown
  > | null
  const [error] = errors
  if (error)
    throw new Error(
      `${name}, line ${text.slice(0, error.offset).split('\n').length}: ${printParseErrorCode(error.error)}.`,
    )
  const { system_model_file: model, tmax, output_file: output } = json ?? {}
  if (typeof model !== 'string' || !/\.case\.json$/i.test(model))
    throw new Error(`${name} names no .case.json in its system_model_file.`)
  if (typeof tmax !== 'number' || !(tmax > 0))
    throw new Error(`${name}: tmax must be a time after 0.`)
  return { model, tmax, ...(typeof output === 'string' && { output }) }
}

/** Where a run writes its samples, by GridKit's rule in parseStudyData: the case's monitor, else
 *  the solver file's output_file. */
export function outputOf(name: string, solver: Solver, monitor: Sink | undefined): Sink {
  if (monitor) return monitor
  if (solver.output !== undefined) return { file: solver.output, format: 'csv' }
  throw new Error(
    `${name} names no output_file and its case has no monitor, so a run would write nothing to show.`,
  )
}

/** The file contingency `n` of a study writes. */
export const contingencyFile = ({ base, ext }: { base: string; ext: string }, n: number) =>
  `${base}_${n}${ext}`
```

### src/extension/runs.ts (replaces tasks.ts)

```ts
/** GridKit's programs, run on a .solver.json from its menu as a shell runs them:
 *  `DynamicSimulation IEEE39.solver.json` in the solver file's folder. The solver file names the
 *  case, whose Monitor shows the run. A notification says how far it has come, and cancelling it
 *  stops the run. */

import { dirname, isAbsolute, resolve } from 'node:path'

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import type { GridKit, Program, SimulationInfo } from '../shared/messages.js'
import { outputOf, readSolver } from '../shared/study.js'
import { cacheBytesOf, notice, type Sessions } from './sessions.js'
import { showView } from './views.js'

// gridkitOf() moves here from tasks.ts as it is.

const nameOf = (uri: vscode.Uri) => uri.path.split('/').at(-1)!

/** `path` as GridKit reads it in solver file `solver`: relative to its folder unless absolute. */
const near = (solver: vscode.Uri, path: string) =>
  isAbsolute(path) ? vscode.Uri.file(path) : vscode.Uri.joinPath(solver, '..', path)

/** How far a run has come, in percent and in words. A study runs its contingencies at once, so
 *  only a simulation counts. */
function progressOf(program: Program, { state, span, domain }: SimulationInfo) {
  if (program === 'ContingencyAnalysis') return { percent: 0, message: 'Faulting each bus' }
  if (state !== 'running' || !span || !(span[1] > span[0]))
    return { percent: 0, message: 'Starting' }
  return {
    percent: (100 * (domain[1] - span[0])) / (span[1] - span[0]),
    message: `${formatNumber(domain[1])} of ${formatNumber(span[1])} s`,
  }
}

export function registerRuns(studio: Sessions) {
  /** Each case's run, from its menu until it ends. Aborting one stops it. */
  const runs = new Map<string, AbortController>()

  const run = (program: Program) => async (solver: unknown) => {
    if (!(solver instanceof vscode.Uri) || solver.scheme !== 'file')
      throw new Error('Right-click a .solver.json on this machine to run it.')
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to execute GridKit.')
    const input = await vscode.workspace.openTextDocument(solver)
    const study = readSolver(nameOf(solver), input.getText())
    const model = near(solver, study.model)
    const uri = model.toString()
    if (runs.has(uri)) throw new Error(`${nameOf(model)} is already running.`)
    const stop = new AbortController()
    runs.set(uri, stop)
    try {
      const document = await vscode.workspace.openTextDocument(model)
      // GridKit reads the files as saved, so they are saved first, as VS Code's tasks do.
      for (const each of [input, document])
        if (each.isDirty && !(await each.save()))
          throw new Error(`${nameOf(each.uri)} was not saved.`)
      // The Monitor reads the output against the case, so Studio must read the case. Whether
      // GridKit accepts it is GridKit's to say.
      const summary = await studio.documents.ensure(document).catch(() => undefined)
      if (!summary)
        throw notice(`${nameOf(model)} has problems to fix before it can run.`, {
          title: 'Show Problems',
          command: 'workbench.actions.view.problems',
        })
      if (!Object.keys(summary.recording.listed).length)
        throw notice(`${nameOf(model)} records nothing.`, {
          title: 'Choose Signals',
          command: 'gridkitStudio.chooseSignals',
        })
      const sink = outputOf(nameOf(solver), study, summary.recording.monitor)
      const output = near(solver, sink.file)
      // A run removes the file it writes before it starts, so that file must not be one it reads.
      if ([solver, model].some((file) => file.toString() === output.toString()))
        throw new Error(`${nameOf(solver)} would write its samples over ${nameOf(output)}.`)
      await studio.open(document)
      await showView('monitor')
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${program} ${nameOf(solver)}`,
          cancellable: true,
        },
        async (progress, token) => {
          let shown = 0
          const listening = [
            token.onCancellationRequested(() => stop.abort()),
            studio.client.event.event((event) => {
              if (event.kind !== 'run' || event.info.revision.uri !== uri) return
              const { percent, message } = progressOf(program, event.info)
              progress.report({ increment: percent - shown, message })
              shown = percent
            }),
          ]
          try {
            // The call is the run. It settles when the run ends, and aborting it stops the run.
            await studio.client.call(
              'run',
              {
                uri,
                version: summary.version,
                program,
                solver: solver.fsPath,
                output: output.fsPath,
                format: sink.format,
                tmax: study.tmax,
                // What a container mounts: the solver file's workspace folder.
                root: (
                  vscode.workspace.getWorkspaceFolder(solver)?.uri ??
                  vscode.Uri.joinPath(solver, '..')
                ).fsPath,
                gridkit: gridkitOf(model),
                cacheBytes: cacheBytesOf(model),
              },
              stop.signal,
            )
          } finally {
            for (const each of listening) each.dispose()
          }
        },
      )
    } finally {
      runs.delete(uri)
    }
  }

  return [
    studio.command('gridkitStudio.runSimulation', run('DynamicSimulation')),
    studio.command('gridkitStudio.runContingencies', run('ContingencyAnalysis')),
    studio.command('gridkitStudio.stopSimulation', () => runs.get(studio.active ?? '')?.abort()),
  ]
}
```

A run that fails or stops is still reported by `Sessions.#narrate`. A cancelled call rejects with an AbortError, which `report()` already lets go.

### src/gridkit/recording.ts (new)

```ts
/** What a case records, and where: each element's `mon` list, and the case's `monitors`. GridKit
 *  writes a column for every output an element lists, so the lists are all a run records. */

import type { SourceEdit, Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Table } from './case.js'
import { textOffset } from './edits.js'

const decoder = new TextDecoder()

/** GridKit's name for `field`, an output of `table`. */
const outputName = (table: Table, field: string) =>
  (table.shape.plan.get(field)!.source as { name: string }).name

/** The outputs row `row` of `table` lists. */
function listed(kase: Case, table: Table, row: number): string[] {
  const mons = kase.arrays[table.shape.array!]!.mons
  const record = table.records[row]!
  const from = mons[2 * record]!
  return from > 0
    ? (JSON.parse(decoder.decode(kase.file.subarray(from, mons[2 * record + 1]))) as string[])
    : []
}

/** What the case records: how many of each type's elements list each output, and the monitor
 *  GridKit writes to, its last CSV one, or an Arrow one Studio also reads. */
export function recordingOf(kase: Case): Summary['recording'] {
  const counts: Record<string, Record<string, number>> = {}
  for (const table of kase.tables.values()) {
    if (!table.shape.array || !table.shape.outputOrder.size) continue
    const fields = new Map(
      [...table.shape.outputOrder.keys()].map((field) => [outputName(table, field), field]),
    )
    for (let row = 0; row < table.records.length; row++)
      for (const name of listed(kase, table, row)) {
        const field = fields.get(name)
        if (field === undefined) continue
        const type = (counts[table.shape.type] ??= {})
        type[field] = (type[field] ?? 0) + 1
      }
  }
  const monitor = monitorOf(kase)
  return { listed: counts, ...(monitor && { monitor }) }
}

function monitorOf(kase: Case): Sink | undefined {
  if (!kase.monitors) return undefined
  const text = decoder.decode(kase.file.subarray(kase.monitors.value, kase.monitors.end))
  const sinks = JSON.parse(text) as { file_name?: unknown; format?: unknown }[]
  for (const { file_name, format } of sinks.toReversed())
    if (typeof file_name === 'string' && /^(csv|arrow)$/i.test(String(format)))
      return { file: file_name, format: String(format).toLowerCase() as Sink['format'] }
  return undefined
}

/** The edits that make every element of `type` list the outputs in `add` and none in `remove`. A
 *  list keeps its order, and what it gains goes last. A record with no list gains one. */
export function recordEdits(
  kase: Case,
  type: string,
  add: readonly string[],
  remove: readonly string[],
): SourceEdit[] {
  const table = kase.table(type)
  const array = kase.arrays[table.shape.array!]!
  const adding = add.map((field) => outputName(table, field))
  const removing = remove.map((field) => outputName(table, field))
  const edits: SourceEdit[] = []
  for (let row = 0; row < table.records.length; row++) {
    const before = listed(kase, table, row)
    const kept = before.filter((name) => !removing.includes(name))
    const after = [...kept, ...adding.filter((name) => !kept.includes(name))]
    if (after.length === before.length && after.every((name, n) => name === before[n])) continue
    const record = table.records[row]!
    const from = array.mons[2 * record]!
    const brace = array.ends[record]! - 1
    const [start, end] = from > 0 ? [from, array.mons[2 * record + 1]!] : [brace, brace]
    const offset = textOffset(kase, start)
    const text = JSON.stringify(after)
    edits.push({
      offset,
      length: textOffset(kase, end) - offset,
      text: from > 0 ? text : `, "mon": ${text}`,
    })
  }
  return edits
}
```

```diff
 // worker/cases.ts summarize()
-    parameters: parametersOf(kase.catalog),
+    recording: recordingOf(kase),

 // shared/messages.ts
 export interface Summary {
   …
-  parameters: Parameters
+  /** What the case records: how many of each type's elements list each output, and the monitor
+   *  GridKit writes to, if the case has one. */
+  recording: { listed: Record<string, Record<string, number>>; monitor?: Sink }
 }
 export type Mutation =
   …
+  /** Every element of `type` lists the outputs in `add` and none in `remove`. */
+  | { kind: 'record'; type: string; add: readonly string[]; remove: readonly string[] }

 // gridkit/plan.ts, first in planTransaction
+  // What a case records is a batch of its own: one edit per element whose list changes.
+  const records = mutations.filter((mutation) => mutation.kind === 'record')
+  if (records.length) {
+    if (records.length < mutations.length)
+      throw failure('invalid-input', 'Change what a case records in a batch of its own.')
+    return records
+      .flatMap(({ type, add, remove }) => recordEdits(kase, type, add, remove))
+      .sort((a, b) => a.offset - b.offset)
+  }
```

`recordingOf` decodes only the `mon` lists a case has, so a case that records a few devices costs a few small parses per summary.

### src/results: a file says what it holds

`Results` already reads a file's header first and builds its column layout from it. Today that layout matches the header against a field list it was handed, from Studio's own recording or from a separate pass over the file in `selection.ts`. Now the header is the field list.

```ts
// results/decode.ts. Field and outputOf() move here from gridkit/parameters.ts.

/** What a results file holds, from its header alone: each output of the case whose column it has,
 *  matched by name in catalog and row order, and the column each of their rows reads. A name that
 *  repeats matches its rows in turn. A column the case has no output for is left unread. */
export function layoutOf(header: readonly ArrowField[], kase: Case): { fields: Field[]; plan: Plan } {
  if (header.length === 0) throw failure('io', 'The results do not start with a time column.')
  const columns = new Map<string, number[]>()
  header.forEach((field, column) => {
    if (column === 0) return
    const name = fold(field.name)
    const found = columns.get(name)
    if (found) found.push(column)
    else columns.set(name, [column])
  })
  const fields: Field[] = []
  const placed: Int32Array[] = []
  for (const table of kase.tables.values())
    for (const [name] of table.shape.outputOrder) {
      const rows: number[] = []
      const at: number[] = []
      for (let row = 0; row < table.records.length; row++) {
        const column = columns.get(fold(columnName(kase, table, row, name)))?.shift()
        if (column === undefined) continue
        rows.push(row)
        at.push(column)
      }
      if (!rows.length) continue
      fields.push(outputOf(kase.data.tables[table.shape.type]!.index, name, Uint32Array.from(rows)))
      placed.push(Int32Array.from(at))
    }
  if (!fields.length)
    throw failure('io', 'No result columns match this case. Open the case that wrote them.')
  return { fields, plan: planOf(header, placed) }
}
// planOf() is the second half of today's placementOf(): float64 columns and even strides.
```

```diff
 // results/decode.ts
 export interface Layout {
-  fields?: readonly ArrowField[]
-  plan?: Plan
+  /** The header's columns, which a CSV page after the first is read with. */
+  header?: readonly ArrowField[]
+  /** What the header says the file holds, and where. */
+  read?: { fields: readonly Field[]; plan: Plan }
 }

 export async function readResults(
   source: Readable,
-  outputs: readonly Field[],
   kase: Case,
   reading: Reading,
   format: ResultFormat,
   layout: Layout,
 )
 …
-    for await (const message of format === 'csv' ? csvMessages(chunks, layout.fields) : messages(chunks)) {
+    for await (const message of format === 'csv' ? csvMessages(chunks, layout.header) : messages(chunks)) {
       if (message.kind === 'schema') {
         if (plan) throw failure('io', 'The results repeat their schema.')
-        layout.fields ??= message.fields
-        plan = layout.plan ??= placementOf(message.fields, outputs, kase)
+        layout.header ??= message.fields
+        layout.read ??= layoutOf(message.fields, kase)
+        plan = layout.read.plan
         continue
       }
 // The frame size, the batch arrays and the no-outputs check read layout.read.fields, which the
 // header has set by the time any row arrives.

 // results/results.ts
 export class Results {
   constructor(
     readonly info: SimulationInfo,
     readonly kase: Case,
-    readonly fields: readonly Field[],
     readonly cache: ResultCache,
-    readonly ownedDirectory?: string,
   ) {}
+  /** What the file holds, once its header is read. Reading it also tells the views, through
+   *  `info.outputs`, which signals they can plot and map. */
+  get fields(): readonly Field[] {
+    return this.#layout.read?.fields ?? []
+  }
-  async dispose(scratchRoot: string) { … }
```

### src/gridkit/simulation.ts (rewritten)

```ts
/** One run of GridKit on a solver file, in its folder. A DynamicSimulation is read while it writes
 *  its output. A ContingencyAnalysis shows the first contingency it wrote once it ends. */

import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ResultCache, Results } from '../results/index.js'
import type { RuntimeProcess, SimulationInfo, SimulationRequest } from '../shared/simulation.js'
import { contingencyFile } from '../shared/study.js'
import type { Case } from './case.js'
import { launch } from './runtime.js'

export interface RunContext {
  readonly signal: AbortSignal
  /** Hears each Results the run reads, as soon as it reads it, so views can query it as it fills. */
  readonly reading: (results: Results) => void
  readonly publish: () => Promise<void>
  readonly log: (message: string) => void
  readonly lifecycle?: (process?: RuntimeProcess) => void
}

export async function simulate(
  kase: Case,
  request: SimulationRequest,
  info: SimulationInfo,
  cache: ResultCache,
  context: RunContext,
): Promise<Results> {
  const { program, solver, output, root, gridkit } = request
  const folder = dirname(solver)
  // GridKit names a study's files from the output's stem alone, so they land where it runs.
  const ext = extname(output)
  const study = { base: join(folder, basename(output, ext)), ext }
  const stem = basename(study.base)
  const pattern = new RegExp(`^${RegExp.escape(stem)}_(\\d+)${RegExp.escape(ext)}$`)
  const written = async () =>
    (await readdir(folder)).flatMap((name) => {
      const n = pattern.exec(name)?.[1]
      return n === undefined ? [] : [Number(n)]
    })
  // Studio reads what GridKit writes, so what this program is about to write over goes first,
  // and nothing the last run left can pass for this run's.
  const stale =
    program === 'DynamicSimulation'
      ? [output]
      : (await written()).map((n) => contingencyFile(study, n))
  await Promise.all(stale.map((file) => rm(file, { force: true })))
  const process = await launch(
    gridkit,
    program,
    { root, solver, touches: [fileURLToPath(request.uri), output] },
    context.signal,
    context.log,
    context.lifecycle,
  )
  try {
    if (program === 'DynamicSimulation') {
      const results = new Results(info, kase, cache)
      context.reading(results)
      await results.ingest(context.signal, process.ended, context.publish)
      await process.done
      if (!info.frames) throw new Error(`DynamicSimulation wrote no samples to ${basename(output)}.`)
      return results
    }
    await process.done
    const contingencies = (await written()).sort((a, b) => a - b)
    if (!contingencies.length)
      throw new Error('No contingency wrote results. See Output › GridKit Studio.')
    const buses = kase.table(kase.catalog.bus)
    info.contingency = {
      ...study,
      buses: Array.from(buses.records, (_, row) => kase.native(buses, row) as number),
      written: contingencies,
      failed: [...process.failed()],
      shown: contingencies[0]!,
    }
    info.path = contingencyFile(study, info.contingency.shown)
    const results = new Results(info, kase, cache)
    context.reading(results)
    await results.ingest(context.signal, () => true, context.publish)
    return results
  } catch (error) {
    context.signal.throwIfAborted()
    // A native error is more useful than the missing file it caused.
    if (process.ended()) await process.done
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${program} wrote no ${basename(output)}. See Output › GridKit Studio.`)
    throw error
  } finally {
    await process.stop()
    await process.done.catch(() => {})
  }
}
```

### src/gridkit/runtime.ts

```diff
-/** Where a container sees the run's folder. */
-const MOUNT = '/simulation'
+/** Where a container sees the workspace folder. */
+const MOUNT = '/workspace'
+
+/** Where a run happens: GridKit runs `solver` in its folder, and a container mounts `root`, which
+ *  must hold every file the run `touches`. */
+export interface Place {
+  readonly root: string
+  readonly solver: string
+  readonly touches: readonly string[]
+}

 export function containerArgs(
   program: Program,
   image: string,
-  directory: string,
+  place: Place,
   name: string,
   host: { … },
 ): string[] {
   …
-    // SELinux hosts let the container write the folder only once it is labeled for it.
-    '--volume',
-    `${directory}:${MOUNT}${linux ? ':Z' : ''}`,
-    '--workdir',
-    MOUNT,
+    // SELinux hosts let a container write a folder only once it is labeled for it. The workspace
+    // is the user's, so its label is shared rather than private to one container.
+    '--volume',
+    `${place.root}:${MOUNT}${linux ? ':z' : ''}`,
+    '--workdir',
+    posix.join(MOUNT, ...relative(place.root, dirname(place.solver)).split(sep)),
   …
     image,
     program,
-    'input.json',
+    basename(place.solver),
   ]
 }

-/** Runs `program` on the `input.json` staged in `directory`, as `gridkit` says. … */
+/** Runs `program` on the solver file `place` names, in its folder, as `gridkit` says. … */
 export async function launch(
   gridkit: GridKit,
   program: Program,
-  directory: string,
+  place: Place,
   signal: AbortSignal,
   …
 ) {
   const runtime = await available(gridkit, program)
+  if (runtime.kind === 'container')
+    for (const path of [place.solver, ...place.touches]) {
+      const inside = relative(place.root, path)
+      if (inside.startsWith('..') || isAbsolute(inside))
+        throw new Error(`${basename(path)} is outside ${place.root}, the folder GridKit's container mounts.`)
+    }
   …
   const [command, args] =
     runtime.kind === 'installed'
-      ? [runtime.program, ['input.json']]
-      : [runtime.cli, containerArgs(program, runtime.image, resolve(directory), container!.name, { … })]
+      ? [runtime.program, [basename(place.solver)]]
+      : [runtime.cli, containerArgs(program, runtime.image, place, container!.name, { … })]
   const child = spawn(command, args, {
-    cwd: directory,
+    cwd: dirname(place.solver),
   …
-      const study = /Study failed for fault: (\S+)/.exec(text)
+      // GridKit names a failed contingency by its bus's name, which may hold spaces.
+      const study = /Study failed for fault: (.+)$/.exec(text)
   …
-    try {
-      await writeFile(join(directory, 'solver.log'), tail.join('\n') + '\n')
-    } finally {
-      lifecycle()
-    }
+    lifecycle()
```

The run's lines already go to Output › GridKit Studio, so Studio writes no `solver.log` into the user's folder.

### src/worker.ts

```ts
/** Each case's run, by case. */
const running = new Map<string, { controller: AbortController; done: Promise<SimulationInfo> }>()

/** Runs GridKit as `input` says and reads what it writes. The request is the run, so cancelling it
 *  stops the run. */
async function runCase(input: SimulationRequest, signal: AbortSignal): Promise<SimulationInfo> {
  const { kase } = get(input)
  if (running.has(input.uri)) throw failure('invalid-input', `${kase.name} is already running.`)
  cache.limit = cacheLimit(input.cacheBytes)
  const info: SimulationInfo = {
    id: crypto.randomUUID(),
    command: `${input.program} ${basename(input.solver)}`,
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    name: kase.name,
    state: 'running',
    path: input.output,
    format: input.format,
    frames: 0,
    domain: [0, 0],
    span: [0, input.tmax],
    started: Date.now(),
    outputs: [],
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Simulation cancelled.'))
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const done = (async () => {
    send({ kind: 'run', info })
    try {
      await simulate(kase, input, info, cache, {
        signal: controller.signal,
        reading: (results) => void retain(input.uri, results),
        // …today's progress throttling: a run message at most every PROGRESS_MS
        publish: async () => {},
        // …today's log throttling through solverLine(message, input.program, said)
        log: () => {},
        lifecycle: (process) => send({ kind: 'process', uri: input.uri, process }),
      })
      info.state = 'complete'
    } catch (error) {
      info.state = controller.signal.aborted
        ? controller.signal.reason?.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed'
      info.message = message(error)
      if (defect(error)) send({ kind: 'log', level: 'error', message: detail(error) })
    } finally {
      send({ kind: 'run', info })
    }
    return info
  })()
  running.set(input.uri, { controller, done })
  try {
    return await done
  } finally {
    running.delete(input.uri)
    signal.removeEventListener('abort', cancel)
  }
}

/** A GridKit results file read for the case: Open Results…, a session restored after a reload, or
 *  another contingency of a study. Its header says what it holds. It answers only its caller. */
async function openResults(input: Requests['open']['input'], signal: AbortSignal) {
  const { kase } = get(input)
  cache.limit = cacheLimit(input.cacheBytes)
  const info: SimulationInfo = {
    id: crypto.randomUUID(),
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    name: basename(input.path),
    state: 'complete',
    path: input.path,
    format: extname(input.path).toLowerCase() === '.csv' ? 'csv' : 'arrow',
    frames: 0,
    domain: [0, 0],
    started: (await stat(input.path)).mtimeMs,
    outputs: [],
    ...(input.contingency && { contingency: input.contingency }),
  }
  const results = new Results(info, kase, cache)
  await readers.use([results], signal, (s) => results.ingest(s, () => true, async () => {}))
  await retain(input.uri, results)
  return info
}
```

```diff
 // dispatch
-    case 'prepareSimulation': …
-    case 'getSimulation': …
-    case 'stopSimulation': …
-    case 'stop': …
-    case 'import': { … 60 lines … }
-    case 'contingency': { … }
-    case 'elements': { … }
-    case 'run':
-      return runCase(request.input)
+    case 'run':
+      return runCase(request.input, signal)
+    case 'open':
+      return openResults(request.input, signal)
     case 'describeSimulation': {
-      const result = await loadResult(request.input.simulationId, signal)
+      const result = findRun(request.input.simulationId)
       …
     case 'shutdown':
-      await recordingsReady
-      await Promise.all([...simulations.entries.keys()].map((id) => stopSimulation(id, true)))
-      for (const load of loading.values()) …
-      await eviction
-      await storage.flush()
+      for (const { controller } of running.values())
+        controller.abort(
+          Object.assign(new Error('The extension stopped before this simulation completed.'), {
+            interrupted: true,
+          }),
+        )
+      await Promise.allSettled([...running.values()].map(({ done }) => done))
       return null
     case 'clear': {
-      … stopSimulation, discard, storage.removeRecording …
+      // Studio forgets the case's runs. Their files are the user's, and stay.
+      running.get(request.input.uri)?.controller.abort()
+      for (const result of histories.get(request.input.uri) ?? []) result.release()
+      histories.delete(request.input.uri)
       return null
     }
```

Also gone from the worker: `storage`, `scratch`, `owners`, `ownerOf`, `discard`, `trimRecordings`, `ensureRecordingsReady`, `loading`, `protectedRecordings`, `prepareSimulation`, `stopSimulation`, `Simulations`, and `loadResult`, which becomes `findRun`.

### src/shared/simulation.ts

```ts
/** GridKit's programs Studio runs on a solver file. */
export type Program = 'DynamicSimulation' | 'ContingencyAnalysis'

export interface SimulationInfo {
  id: string
  revision: Revision
  fingerprint: string
  name: string
  /** What a shell would run for it, as `DynamicSimulation IEEE39.solver.json`. Absent for a file
   *  opened alone. */
  command?: string
  state: 'running' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  /** The GridKit results file it reads. */
  path: string
  format: 'arrow' | 'csv'
  frames: number
  domain: Domain
  span?: Domain
  domains?: Record<string, Record<string, Domain>>
  message?: string
  started: number
  /** What the file holds, once its header is read. */
  outputs: readonly FieldSelection[]
  /** A ContingencyAnalysis: each bus in case order, the contingencies that wrote a file, the bus
   *  names GridKit reported failed, and the one shown. Contingency `n` faults `buses[n]` and
   *  reads `${base}_${n}${ext}`. */
  contingency?: {
    base: string
    ext: string
    buses: readonly number[]
    written: readonly number[]
    failed: readonly string[]
    shown: number
  }
}

export interface SimulationRequest extends Revision {
  program: Program
  /** The .solver.json GridKit runs, in its folder. */
  solver: string
  /** Where it writes its samples, and how, as the solver file and its case say. */
  output: string
  format: 'csv' | 'arrow'
  /** When the run ends, for its progress. */
  tmax: number
  /** The folder a container mounts. */
  root: string
  gridkit: GridKit
  cacheBytes: number
}
```

```diff
 // shared/messages.ts Requests
-  prepareSimulation: …
-  getSimulation: …
-  stopSimulation: …
-  stop: { input: { uri: string }; output: null }
-  import: { input: Revision & { path: string; cacheBytes: number }; output: SimulationInfo }
-  contingency: { input: { run: string; shown: number }; output: SimulationInfo }
-  elements: …
+  /** A GridKit results file read for the case at its revision. */
+  open: {
+    input: Revision & {
+      path: string
+      cacheBytes: number
+      contingency?: SimulationInfo['contingency']
+    }
+    output: SimulationInfo
+  }
 // − ViewKind 'simulation', ViewState values, launching and outputs, FromView 'values',
 //   ViewRequests elements, ElementChoice
```

### src/extension/signals.ts

The tree reads `Summary.recording` as every view reads the summary. Its refresh stays the synchronous one it has today.

```ts
/** Monitored Signals: what the case's runs record, which is its elements' `mon` lists. A field is
 *  checked when every element of its type lists it. Checking it makes every one list it, as one
 *  edit of the case that undo reverses. */

// Signal, recordable() and checked() stay as they are. shown() keeps returning the active case and
// its summary, without outputs.

    getChildren(parent) {
      const now = shown()
      if (!now || parent?.field !== undefined) return []
      const { uri, summary } = now
      const count = (type: string, field: string) => summary.recording.listed[type]?.[field] ?? 0
      const types = recordable(summary)
      if (!parent)
        return types.map(({ type, fields }) => {
          const name = typeName(summary.schema, type)
          const on = fields.filter((field) => count(type, field) === summary.counts[type]).length
          const item = new Signal(type, undefined, name, vscode.TreeItemCollapsibleState.Collapsed)
          item.id = `${uri}\n${type}`
          item.description = `${on}/${fields.length}`
          return item
        })
      const total = summary.counts[parent.type] ?? 0
      const definitions = summary.schema.types[parent.type]?.fields ?? {}
      return (types.find(({ type }) => type === parent.type)?.fields ?? []).map((field) => {
        const n = count(parent.type, field)
        const label = fieldName(definitions[field], field)
        const item = new Signal(parent.type, field, label, vscode.TreeItemCollapsibleState.None)
        item.id = `${uri}\n${parent.type}\n${field}`
        item.checkboxState = checked(n > 0 && n === total)
        // When only some list it, the count says how many, and checking it makes every one.
        if (n > 0 && n < total) item.description = `${n.toLocaleString()} of ${total.toLocaleString()}`
        item.tooltip = definitions[field]?.description ?? label
        return item
      })
    },

  /** One edit of the case: each type's elements list `add` and none of `remove`. */
  const record = (changes: readonly Extract<Mutation, { kind: 'record' }>[], label: string) => {
    const now = shown()
    if (now && changes.length)
      void studio.documents
        .transact(now.uri, now.summary.version, changes, label)
        .catch((error) => studio.report(error))
  }
  view.onDidChangeCheckboxState(({ items }) => {
    const changes = new Map<string, { kind: 'record'; type: string; add: string[]; remove: string[] }>()
    for (const [{ type, field }, state] of items) {
      if (field === undefined) continue
      const change = changes.get(type) ?? { kind: 'record' as const, type, add: [], remove: [] }
      changes.set(type, change)
      if (state === vscode.TreeItemCheckboxState.Checked) change.add.push(field)
      else change.remove.push(field)
    }
    record([...changes.values()], 'Change recorded signals')
  })
  const every = (on: boolean) => () => {
    const now = shown()
    if (now)
      record(
        recordable(now.summary).map(({ type, fields }) => ({
          kind: 'record',
          type,
          add: on ? fields : [],
          remove: on ? [] : fields,
        })),
        on ? 'Record all signals' : 'Record no signals',
      )
  }
```

### sessions.ts, views.ts, commands.ts, client.ts

```diff
 // sessions.ts
 export interface Session {
-  previous?: SimulationInfo
-  /** Whether Run was pressed and GridKit's run has not yet begun. */
-  launching: boolean
-  /** Undefined until the first parsed case supplies defaults; an empty array records nothing. */
-  outputs?: FieldSelection[]
-  values: Record<string, unknown>
 }
-type Saved = Partial<Pick<Session, 'bindings' | 'values' | 'plots' | 'table'>> & {
-  recording?: FieldSelection[]
-  simulationId?: string
-}
+type Saved = Partial<Pick<Session, 'bindings' | 'plots' | 'table'>> & {
+  /** The results file the Monitor showed, read again when the case first opens. */
+  results?: { path: string; contingency?: SimulationInfo['contingency'] }
+}
-export function defaultOutputs(…) { … }
-function opening(info: SimulationInfo): string[] { … }
+/** How a run starts, for the log: what a shell would run, and its times. */
+const opening = ({ command, name, span }: SimulationInfo) =>
+  `▶ ${command ?? name}${span ? ` · ${formatNumber(span[0])} to ${formatNumber(span[1])} s` : ''}`
+
+/** The `resultCacheMiB` setting for `uri`, in bytes. Moved from tasks.ts. */
+export function cacheBytesOf(uri: vscode.Uri) { … }

 // open(): once per session, the file the Monitor last showed is read again. A run started in the
 // meantime shows instead, and a file that no longer reads is forgotten.
+    if (!this.#restored.has(session)) {
+      this.#restored.add(session)
+      const saved = this.context.workspaceState.get<Saved>('case:' + session.uri)?.results
+      if (saved)
+        void this.client
+          .call('open', {
+            uri: session.uri,
+            version: summary.version,
+            ...saved,
+            cacheBytes: cacheBytesOf(document.uri),
+          })
+          .then(
+            (info) => !session.run && this.show(session, info),
+            () => !session.run && this.persist(session),
+          )
+    }
 // persist(): results: session.run && { path: session.run.path, contingency: session.run.contingency }
 // updateContexts():
-      running: session?.run?.state === 'running' || !!session?.launching,
+      running: session?.run?.state === 'running',
+      contingency: session?.run?.state === 'complete' && !!session.run.contingency,
 // #narrate(): a study with failures lists the bus names GridKit reported.
 // − activate()'s getSimulation restore, record(), and bind() adding a mapped field to recordings
 // show(): − previous

 // views.ts
-const COMMANDS = new Set([…, 'startSimulation', 'stopSimulation', 'chooseSignals', 'showContingency'])
+const COMMANDS = new Set(['elementSource', 'plot', 'addPlot', 'removePlot', 'chooseSignals'])
-  if (kind === 'simulation' && launching) parts.push('starting')
-  else if ((kind === 'simulation' || kind === 'monitor') && run) { … }
+  // What a run left. How far one has come is its notification's to say.
+  if (kind === 'monitor' && run) {
+    if (run.contingency) parts.push(`bus ${run.contingency.buses[run.contingency.shown]}`)
+    if (run.frames) parts.push(`${run.frames.toLocaleString()} samples`)
+  }
 // − SHOWN.simulation, EMPTY.simulation, the elements request, and 'simulation' in showView() and
 //   the registration loop

 // client.ts: − scratchFolder(), sweep(), and the scratch, storage and storageBytes worker data

 // commands.ts: − startSimulation, stopSimulation, showContingency, addFault, simulationSettings,
 //   importResults. addPlot offers the shown run's outputs.
+  /** Show results the worker read for the case. */
+  const show = (session: Session, info: SimulationInfo) => {
+    studio.show(session, info)
+    changed(session)
+  }
+  // A study shows one contingency at a time, chosen from the Monitor's title bar.
+  command('chooseContingency', async ({ session, summary }) => {
+    const study = session.run?.contingency
+    if (!study) return
+    const choice = await vscode.window.showQuickPick(
+      study.written.map((n) => ({ label: `Bus ${study.buses[n]}`, n })),
+      { title: 'Show contingency', placeHolder: `Showing bus ${study.buses[study.shown]}` },
+    )
+    if (!choice || choice.n === study.shown) return
+    show(
+      session,
+      await studio.client.call('open', {
+        uri: session.uri,
+        version: summary.version,
+        path: contingencyFile(study, choice.n),
+        contingency: { ...study, shown: choice.n },
+        cacheBytes: cacheBytesOf(vscode.Uri.parse(session.uri)),
+      }),
+    )
+  })
+  // Any GridKit results file, read for the case as a run's own is.
+  command('openResults', async (context) => {
+    const [file] =
+      (await vscode.window.showOpenDialog({
+        filters: { 'GridKit results': ['csv', 'arrow'] },
+        canSelectMany: false,
+      })) ?? []
+    if (!file) return
+    show(
+      context.session,
+      await studio.client.call('open', {
+        uri: context.session.uri,
+        version: context.summary.version,
+        path: localPath(file),
+        cacheBytes: cacheBytesOf(file),
+      }),
+    )
+    await plot(context)
+  })

 // Monitor.svelte
-            ? 'Start a simulation or import results to plot recorded signals.'
+            ? 'Run a .solver.json from its menu, or open results, to plot recorded signals.'
```

### cases/

`cases/` is GridKit's cases at the ref the default image is built from, so the samples always match the GridKit that runs them. GridKit's example solver files are validation harnesses that point at reference CSVs, so each sample case gets a short solver file of its own.

```json
{
    "system_model_file": "IEEE39.case.json",
    "output_file": "IEEE39.csv",
    "dt_monitor": 0.004166666666666667,
    "tmax": 10.0,
    "events": [
        { "time": 1.0, "type": "fault_on", "bus": 16, "R": 0.0, "X": 0.01 },
        { "time": 1.15, "type": "fault_off", "bus": 16 }
    ]
}
```

The same file runs both programs. ContingencyAnalysis points the events at each bus in turn.

```js
/** GridKit's cases, copied into cases/ as GridKit has them at the ref the default image is built
 *  from. Each has a short solver file of its own beside it, written for Studio's samples.
 *
 *    node scripts/cases.mjs ../GridKit <ref>
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CASES = {
  IEEE39: 'IEEE39/IEEE39',
  TwoArea: 'TwoArea/TwoArea',
  TwoBusBasic: 'Toy/TwoBusBasic',
  WECC240: 'WECC240/WECC240',
  ACTIVSg2000: 'ACTIVSg2000/ACTIVSg2000',
  ACTIVSg10k: 'ACTIVSg10k/ACTIVSg10k',
}

const [gridkit, ref] = process.argv.slice(2)
if (!gridkit || !ref) throw new Error('Usage: node scripts/cases.mjs <GridKit checkout> <ref>')
for (const [name, path] of Object.entries(CASES))
  writeFileSync(
    `cases/${name}.case.json`,
    execFileSync(
      'git',
      ['-C', gridkit, 'cat-file', 'blob', `${ref}:cases/PhasorDynamics/${path}.case.json`],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    ),
  )
```

### Tests

```ts
// src/shared/study.test.ts
it('reads the case, end time and output a solver file names, and says why one cannot run', …)
it('takes the case's monitor over output_file, as GridKit does', …)
it('refuses a solver file with nowhere to write', …)

// src/gridkit/recording.test.ts
it('records a field on every bus as one edit, and removing it restores the lists', async () => {
  const kase = await Case.read('cases/IEEE39.case.json', catalog)
  const on = await Case.parse(apply(decoder.decode(kase.file), recordEdits(kase, 'Bus', ['Vm'], [])), catalog)
  expect(recordingOf(on).listed.Bus?.Vm).toBe(on.table('Bus').records.length)
  const off = apply(decoder.decode(on.file), recordEdits(on, 'Bus', [], ['Vm']))
  expect(recordingOf(await Case.parse(off, catalog))).toEqual(recordingOf(kase))
})
it('keeps a list's order and gives a record without one a list', …)

// src/results/results.test.ts
it('learns what a file holds from its header, whatever order its columns are in', …)
it('says a file matches no output of the case, instead of reading it empty', …)

// tests/simulation/simulation.test.ts calls simulate() against real GridKit through Docker, on
// copies of the samples in output/simulation/. It checks that the samples appear where the solver
// file says, that a fault named by bus sags that bus, that a study writes one file per bus whose
// buses are the case's own, that a rerun never reads the last run's file, that cancelling stops the
// process and its container, and that an image this machine lacks is refused without a pull.
```

```diff
 // manifest.test.ts
-      ['gridkitStudio.simulation', 'gridkitStudio.signals', 'gridkitStudio.export'],
+      ['gridkitStudio.signals', 'gridkitStudio.export'],
+    // GridKit runs only from a solver file's menus.
+    for (const command of ['gridkitStudio.runSimulation', 'gridkitStudio.runContingencies']) {
+      for (const menu of ['explorer/context', 'editor/context', 'editor/title/context'])
+        expect(manifest.contributes.menus[menu]).toContainEqual(
+          expect.objectContaining({ command, when: 'resourceFilename =~ /\\.solver\\.json$/i' }),
+        )
+      expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' })
+    }
+    expect(manifest.contributes.taskDefinitions).toBeUndefined()
```

The VS Code suites work on a temporary workspace of case and solver files, never on `cases/` itself, because a run writes beside its solver file and Monitored Signals edits the case.

## Decisions for you

Three are for GridKit, where you're writing #611. Each would make Studio's side smaller still.

1. **Make `output_file` the study's file.** Today, when the case has a CSV monitor too, GridKit links `output_file` to it as a symlink, and it errors when a real file is already there. If `output_file` replaced the case's monitor instead, the solver file alone would say where a run writes. Studio's `outputOf()` would read one key, and no symlink would cross a Windows bind mount.
2. **Keep the output's folder in contingency file names.** GridKit builds `<stem>_<n><ext>` from `path.stem()`, so `results/IEEE39.csv` puts its contingencies in the solver file's folder rather than `results/`. Using the output's full path minus its extension would fix that. Studio would then take `base` from the output alone.
3. **Name failed contingencies by bus number.** `Study failed for fault: ` prints the bus's name, which can repeat or be empty. Printing `bus_id` would let the picker mark exactly which contingencies failed.

And one for Studio.

4. **`cases/`.** This retires the "cases minus BusFault" rule. The samples become GridKit's cases at the image's ref, with a short solver file each. Until the default image carries #611, that ref is whatever the image is built from.
