import type { Axis } from '../axes.js'

export function paintAxis(element: HTMLElement, axis: Axis, vertical = false): void {
  const labels = axis.ticks.map((tick) => {
    const label = document.createElement('span')
    label.className = 'tick'
    label.textContent = tick.label
    label.title = String(tick.value)
    label.dataset.edge = tick.position < 0.01 ? 'start' : tick.position > 0.99 ? 'end' : ''
    label.style[vertical ? 'bottom' : 'left'] = `${tick.position * 100}%`
    return label
  })
  element.replaceChildren(...labels)
}
