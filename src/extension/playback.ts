/** Playback: its commands, and the status bar that runs them, right of the problem counts behind a
 *  bar: step back, play or pause, step forward, the time, and the speed. They follow the active
 *  case's clock while its results have samples. A playback command neither reads the case nor
 *  needs it to read: a key held down plays on while the case's file changes. */

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import { type Command, commandId, PREFIX } from '../shared/ids.js'
import { RATES } from '../shared/transport.js'
import type { Commands } from './commands.js'

/** How often the time follows a playing clock. */
const TICK_MS = 100
/** The priority of VS Code's problem counts at the left of the status bar. */
const PROBLEMS = 50

export function registerPlayback({ studio, registrations, command }: Commands) {
  command('playPause', ({ session }) => session.transport.playPause())
  // To the head while frames arrive, else to the run's last sample.
  command('goToEnd', ({ session }) => {
    const { transport } = session
    if (session.live) transport.goLive()
    else transport.seek(transport.state.span[1])
  })
  command('goToTime', async ({ session: { transport } }, value) => {
    if (transport.state.status === 'idle') return
    const text =
      typeof value === 'number'
        ? String(value)
        : await vscode.window.showInputBox({
            title: 'Time [s]',
            value: String(transport.currentT()),
            validateInput: (input) =>
              input.trim() && Number.isFinite(Number(input)) ? null : 'A finite time',
          })
    if (text === undefined) return
    transport.pause()
    transport.seek(Number(text))
  })
  for (const [id, direction] of [
    ['previousSample', -1],
    ['nextSample', 1],
  ] as const)
    command(id, ({ session }) => session.step(direction))
  command('playbackSpeed', async ({ session: { transport } }) => {
    const chosen = await vscode.window.showQuickPick(
      RATES.map((rate) => ({ label: formatNumber(rate) + '×', rate })),
      { title: 'Playback speed', placeHolder: 'Simulated seconds per second' },
    )
    if (chosen) transport.setRate(chosen.rate)
  })

  // Higher priorities sit further left, so the items keep the order they are made in.
  let priority = PROBLEMS
  const item = (id: string, name: string, command?: Command) => {
    const made = vscode.window.createStatusBarItem(
      `${PREFIX}.playback.${id}`,
      vscode.StatusBarAlignment.Left,
      --priority,
    )
    made.name = 'GridKit ' + name
    made.command = command && commandId(command)
    return made
  }
  const bar = item('bar', 'Playback')
  bar.text = '│'
  bar.color = new vscode.ThemeColor('disabledForeground')
  bar.accessibilityInformation = { label: 'Playback', role: 'separator' }
  const back = item('previousSample', 'Previous Sample', 'previousSample')
  const play = item('playPause', 'Play or Pause', 'playPause')
  const forward = item('nextSample', 'Next Sample', 'nextSample')
  const time = item('goToTime', 'Go to Time', 'goToTime')
  const speed = item('playbackSpeed', 'Playback Speed', 'playbackSpeed')
  const items = [bar, back, play, forward, time, speed]
  /** What each item says now: while the clock plays, only the time changes, so only it is sent. */
  const said = new Map<vscode.StatusBarItem, string>()
  const say = (target: vscode.StatusBarItem, text: string, label: string) => {
    if (said.get(target) === text + '\n' + label) return
    said.set(target, text + '\n' + label)
    target.text = text
    target.tooltip = label
    target.accessibilityInformation = { label, role: 'button' }
  }
  let shown = false
  let timer: ReturnType<typeof setInterval> | undefined

  const show = () => {
    const uri = studio.active
    const session = uri ? studio.get(uri) : undefined
    const results = session?.results
    const state = session?.transport.state
    if (!session || !results?.frames || !state || state.status === 'idle') {
      if (shown) for (const each of items) each.hide()
      shown = false
      clearInterval(timer)
      timer = undefined
      return
    }
    const { transport } = session
    const t = transport.currentT()
    const playing = state.status === 'playing'
    const finished = !session.live && !playing && t >= state.span[1]
    // The times a run will cover, which its samples fill as they arrive.
    const [from, to] = results.span ?? results.domain
    const unit = 's'
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
    if (!shown) for (const each of items) each.show()
    shown = true
    if (playing && !timer) timer = setInterval(show, TICK_MS)
    else if (!playing && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
  show()
  registrations.push(...items, studio.changed.event(show), studio.clock.event(show), {
    dispose: () => clearInterval(timer),
  })
}
