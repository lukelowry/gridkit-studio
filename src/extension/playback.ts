/** Playback in the status bar, at its left: step back, play or pause, step forward, the time, the
 *  speed, and the end. They follow the active case's clock while its run has samples. */

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import type { Sessions } from './sessions.js'

/** How often the time follows a playing clock. */
const TICK_MS = 100

export function registerPlayback(studio: Sessions): vscode.Disposable[] {
  // Higher priorities sit further left, so the items keep the order they are made in.
  let priority = 100
  const item = (id: string, name: string, command: string) => {
    const made = vscode.window.createStatusBarItem(
      'gridkitStudio.playback.' + id,
      vscode.StatusBarAlignment.Left,
      priority--,
    )
    made.name = 'GridKit ' + name
    made.command = command
    return made
  }
  const back = item('back', 'Previous Sample', 'gridkitStudio.previousSample')
  const play = item('play', 'Play or Pause', 'gridkitStudio.toggleTimeline')
  const forward = item('forward', 'Next Sample', 'gridkitStudio.nextSample')
  const time = item('time', 'Time', 'gridkitStudio.seekTime')
  const speed = item('speed', 'Playback Speed', 'gridkitStudio.timeSpeed')
  const end = item('end', 'Go to End', 'gridkitStudio.followTime')
  const items = [back, play, forward, time, speed, end]
  const say = (target: vscode.StatusBarItem, text: string, label: string) => {
    target.text = text
    target.tooltip = label
    target.accessibilityInformation = { label, role: 'button' }
  }
  let timer: ReturnType<typeof setInterval> | undefined

  const show = () => {
    const uri = studio.active
    const session = uri ? studio.all.get(uri) : undefined
    const run = session?.run
    const state = session?.transport.state
    if (!session || !run?.frames || !state || state.status === 'idle') {
      for (const each of items) each.hide()
      clearInterval(timer)
      timer = undefined
      return
    }
    const { transport } = session
    const t = transport.currentT()
    const playing = state.status === 'playing'
    const finished = !transport.live && !playing && state.loop === 'none' && t >= state.span[1]
    // The run's configured times, which its samples fill as they arrive.
    const [from, to] = run.span ?? run.domain
    const unit = studio.documents.entries.get(uri!)?.summary?.schema.axis?.unit ?? 's'
    say(back, '$(chevron-left)', 'Previous sample')
    say(
      play,
      playing ? '$(debug-pause)' : finished ? '$(debug-restart)' : '$(play)',
      playing ? 'Pause' : finished ? 'Replay' : 'Play',
    )
    say(forward, '$(chevron-right)', 'Next sample')
    say(
      time,
      `${t.toFixed(2)} / ${to.toFixed(2)} ${unit}`,
      `Time ${formatNumber(t)} ${unit} of ${formatNumber(from)} to ${formatNumber(to)} ${unit}. Go to a time`,
    )
    say(speed, `${formatNumber(state.rate)}×`, `Speed: ${formatNumber(state.rate)}×`)
    say(end, '$(run-all)', transport.live ? 'Go live' : 'Go to end')
    for (const each of items) each.show()
    if (playing && !timer) timer = setInterval(show, TICK_MS)
    else if (!playing && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
  show()
  return [
    ...items,
    studio.changed.event(show),
    studio.clock.event(show),
    { dispose: () => clearInterval(timer) },
  ]
}
