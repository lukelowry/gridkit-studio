import type { SolverOptions } from '../gridkit/solver.js'
export const labels: Record<keyof SolverOptions, string> = {
  tmax: 'End time (s)',
  dt_monitor: 'Output interval (s)',
  dt_fixed: 'Fixed step (s)',
  rel_tol: 'Relative tolerance',
  abs_tol: 'Absolute tolerance',
  max_steps: 'Maximum steps',
  consistent_ic_type: 'Initial conditions',
  events: 'Events',
  output_file: 'Output CSV',
  reference_file: 'Reference CSV',
  error_tolerance: 'Comparison tolerance',
  error_type: 'Comparison error',
  abs_err_threshold: 'Absolute error threshold',
}
