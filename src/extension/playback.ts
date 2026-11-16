/** Playback commands and status bar items. The commands never read the case, so a held key keeps
 *  working while the case file changes. */

import * as vscode from 'vscode'

import { formatNumber } from '../shared/format.js'
import { type Command, commandId, PREFIX } from '../shared/ids.js'
import { RATES } from '../shared/transport.js'
import type { Commands } from './commands.js'

const TICK_MS = 100
/** The status bar priority of VS Code's problem counts. */
const PROBLEMS = 50

/** Prompts for a speed in simulated seconds per second: a preset or any typed positive number. */
function pickRate(): Promise<number | undefined> {
  type Item = vscode.QuickPickItem & { readonly rate: number }
  const item = (rate: number, typed = false): Item => ({
    label: formatNumber(rate) + '×',
    rate,
    alwaysShow: typed,
  })
  const presets = RATES.map((rate) => item(rate))
  const picker = vscode.window.createQuickPick<Item>()
  picker.title = 'Playback Speed'
  picker.placeholder = 'Simulated seconds per second, or type another speed'
  picker.items = presets
  picker.onDidChangeValue((value) => {
    const rate = Number(value.trim().replace(/[×x]$/i, ''))
    const typed = value.trim() && rate > 0 && Number.isFinite(rate)
    picker.items = typed ? [item(rate, true), ...presets] : presets
  })
  return new Promise((resolve) => {
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.rate)
      picker.hide()
    })
    picker.onDidHide(() => {
      resolve(undefined)
      picker.dispose()
    })
    picker.show()
  })
}

export function registerPlayback({ studio, registrations, command }: Commands) {
  command('playPause', ({ session }) => session.transport.playPause())
  // Jumps to the live head while frames arrive, else to the last sample.
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
            title: 'Go to Time [s]',
            value: formatNumber(transport.currentT()),
            validateInput: (input) =>
              input.trim() && Number.isFinite(Number(input)) ? null : 'Enter a time in seconds',
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
    const rate = await pickRate()
    if (rate !== undefined) transport.setRate(rate)
  })

  // Higher priorities sit further left, so decreasing priorities keep creation order.
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
  /** Each item's current text, so only changed items are updated while playing. */
  const texts = new Map<vscode.StatusBarItem, string>()
  const setText = (target: vscode.StatusBarItem, text: string, label: string) => {
    if (texts.get(target) === text + '\n' + label) return
    texts.set(target, text + '\n' + label)
    target.text = text
    target.tooltip = label
    target.accessibilityInformation = { label, role: 'button' }
  }
  let visible = false
  let timer: ReturnType<typeof setInterval> | undefined

  const show = () => {
    const uri = studio.active
    const session = uri ? studio.get(uri) : undefined
    const results = session?.results
    const state = session?.transport.state
    if (!session || !results?.frames || !state || state.status === 'idle') {
      if (visible) for (const each of items) each.hide()
      visible = false
      clearInterval(timer)
      timer = undefined
      return
    }
    const { transport } = session
    const t = transport.currentT()
    const playing = state.status === 'playing'
    const finished = !session.live && !playing && t >= state.span[1]
    // The run's full time span, which its samples fill as they arrive.
    const [from, to] = results.span ?? results.domain
    // Enough decimals to distinguish samples, at a width that stays fixed while playing.
    const digits = Math.min(9, Math.max(2, Math.ceil(-Math.log10(to - from || 1)) + 2))
    setText(back, '$(chevron-left)', 'Previous Sample')
    setText(
      play,
      playing ? '$(debug-pause)' : finished ? '$(debug-restart)' : '$(play)',
      playing ? 'Pause' : finished ? 'Replay' : 'Play',
    )
    setText(forward, '$(chevron-right)', 'Next Sample')
    setText(
      time,
      `${t.toFixed(digits)} / ${to.toFixed(digits)} s`,
      `Go to Time… (${formatNumber(t)} s of ${formatNumber(from)}–${formatNumber(to)} s)`,
    )
    setText(speed, `${formatNumber(state.rate)}×`, `Playback Speed… (${formatNumber(state.rate)}×)`)
    if (!visible) for (const each of items) each.show()
    visible = true
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
