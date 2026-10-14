/** GridKit cases: parsing, editing, navigation, and running GridKit's DynamicSimulation on solver
 *  files. */

export { Case, type Table } from './case.js'
export { catalog, catalogOf } from './definition.js'
export { diagnose, editable, sourceRange } from './edits.js'
export { completionsAt, outline, sourceContext } from './navigation.js'
export { outputName, recordingOf } from './recording.js'
export { available, PROGRAM, sweepOrphans, terminateRuntime } from './runtime.js'
export { type Keeping, simulate } from './simulation.js'
export { applyChanges, delivered, presentation, transaction, unchangedBy } from './transactions.js'
