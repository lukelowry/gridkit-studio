import * as assert from 'node:assert/strict'
import { join } from 'node:path'

import type { Browser, Frame, Page } from 'playwright-core'
import * as vscode from 'vscode'

import { caseText } from '../support/case.js'
import { focus, until } from './wait.js'

export async function runSlice(browser: Browser, workbench: Page, output: string): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'slice.case.json')
  const count = 2000
  const text = caseText(
    {
      header: { case_name: 'Table and bindings' },
      buses: Array.from({ length: count }, (_, i) => ({
        number: i,
        name: i === 1777 ? 'Needle bus' : `Bus ${i}`,
        x: i + 10,
        init: { x: i + 20 },
        params: { x: i + 0.123456789012, kv: 100 + i },
      })),
      devices: Array.from({ length: count - 1 }, (_, i) => ({
        class: 'Branch',
        id: `branch-${i}`,
        ports: { bus1: i, bus2: i + 1 },
        params: { R: (i + 1) / 10000, X: 0.02, rating: 100, length: 10 },
      })),
    },
    2,
  )
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
  await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network', {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  })
  const doc = await vscode.workspace.openTextDocument(uri)
  const find = async (selector: string): Promise<Frame[]> => {
    const found: Frame[] = []
    for (const page of browser.contexts().flatMap((context) => context.pages()))
      for (const frame of page.frames()) {
        try {
          if (await frame.locator(selector).count()) found.push(frame)
        } catch {
          /* hidden views are recreated */
        }
      }
    return found
  }
  const filter = async (query: string) => {
    const pending = vscode.commands.executeCommand('gridkitStudio.filterTable')
    const input = workbench
      .locator('.quick-input-widget input:not([type="checkbox"]):visible')
      .first()
    await input.fill(query)
    await input.press('Enter')
    await pending
    await until(
      () => table.locator('body').getAttribute('data-query'),
      (value) => value === query,
    )
    await table.locator('[role="grid"][aria-busy="false"]').waitFor()
    await focus(table.getByRole('grid'))
  }
  const selectClass = async (label: string) => {
    const pending = vscode.commands.executeCommand('gridkitStudio.selectClass')
    await workbench.locator('.quick-input-list .monaco-list-row').filter({ hasText: label }).click()
    await pending
    await until(
      () => table.locator('body').getAttribute('data-class'),
      (value) => value === (label === 'LoadZ' ? 'load_z' : label.toLowerCase()),
    )
  }
  const submenu = async (name: string) => {
    await workbench.getByRole('menuitem', { name, exact: true }).hover()
  }
  const networks = () => find(`body[data-case=${JSON.stringify(uri.toString())}] #network`)
  const network = (await until(networks, (frames) => frames.length > 0))[0]
  const ready = (frame: Frame) =>
    frame.locator('body[data-state="ready"]').waitFor({ timeout: 30000 })
  await ready(network)
  await workbench.bringToFront()
  await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
  let table = (
    await until(
      () => find('#table .case-data'),
      (frames) => frames.length > 0,
    )
  )[0]
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await workbench.bringToFront()
  await until(() => table.locator('body').getAttribute('data-focus'), Boolean)
  assert.ok(
    await table
      .getByRole('grid')
      .evaluate((el) => el === el.ownerDocument.activeElement && el.ownerDocument.hasFocus()),
  )
  await focus(table.getByRole('grid'))
  assert.equal(
    await table.locator('[role="grid"]').getAttribute('aria-rowcount'),
    String(count + 1),
  )
  assert.ok((await table.locator('.data-row').count()) < 100)
  assert.match(
    await table.locator('.table-context').innerText(),
    /Table and bindings[\s\S]*Bus[\s\S]*2,000 rows/,
  )
  assert.equal(await table.getByRole('searchbox').count(), 0)
  assert.equal(await table.getByRole('combobox').count(), 0)
  assert.equal(await table.getByRole('button', { name: 'Element', exact: true }).count(), 0)
  assert.equal(await table.getByRole('button', { name: 'number', exact: true }).count(), 1)
  assert.equal(await table.getByRole('button', { name: 'class', exact: true }).count(), 0)
  assert.equal(await table.getByRole('button', { name: 'x (top)', exact: true }).count(), 1)
  assert.equal(await table.getByRole('button', { name: 'x (initial)', exact: true }).count(), 1)
  const xHeader = table.getByRole('button', { name: 'x (parameter)', exact: true })
  await xHeader.click()
  await table
    .getByRole('columnheader')
    .filter({ has: xHeader })
    .and(table.locator('[aria-sort="ascending"]'))
    .waitFor()
  await xHeader.click()
  await until(
    () => table.locator('.data-row').first().getAttribute('data-index'),
    (value) => value === '1999',
  )
  assert.match(await table.locator('.data-row').first().innerText(), /1999\.123456789012/)
  await filter('Needle bus')
  await until(
    () => table.locator('[role="grid"]').getAttribute('aria-rowcount'),
    (value) => value === '2',
  )
  assert.match(
    await table.locator('.table-context').innerText(),
    /1 of 2,000 rows[\s\S]*Filter: Needle bus/,
  )
  await vscode.commands.executeCommand('notifications.clearAll')
  await workbench.screenshot({ path: join(output, 'case-table-filtered.png') })
  await focus(table.getByRole('grid'))
  await table.getByRole('grid').press('Control+f')
  const quickInput = workbench
    .locator('.quick-input-widget input:not([type="checkbox"]):visible')
    .first()
  await quickInput.press('Escape')
  await quickInput.waitFor({ state: 'hidden' })
  const cancelFilter = vscode.commands.executeCommand('gridkitStudio.filterTable')
  const filterInput = workbench
    .locator('.quick-input-widget input:not([type="checkbox"]):visible')
    .first()
  await filterInput.fill('No such element')
  await until(
    () => table.getByRole('grid').getAttribute('aria-rowcount'),
    (value) => value === '1',
  )
  await filterInput.press('Escape')
  await cancelFilter
  await until(
    () => table.getByRole('grid').getAttribute('aria-rowcount'),
    (value) => value === '2',
  )
  const row = table.locator('.data-row').first()
  assert.equal(await row.getAttribute('data-index'), '1777')
  await row.locator('.identity').click()
  await until(
    () => network.locator('#network').getAttribute('data-selected'),
    (value) => value === 'vertex:1777',
  )
  await workbench.locator('.statusbar-item').filter({ hasText: 'Bus 1777' }).waitFor()
  const rowContext = JSON.parse((await row.getAttribute('data-vscode-context'))!)
  await row.locator('.identity').click({ button: 'right' })
  await workbench.getByRole('menuitem', { name: 'Bind to Network...', exact: true }).waitFor()
  await workbench.getByRole('menuitem', { name: 'Focus Neighborhood', exact: true }).waitFor()
  const sourceMenu = workbench.getByRole('menuitem', { name: 'Show in Source', exact: true })
  await sourceMenu.hover()
  await workbench.keyboard.press('Enter')
  await until(() => vscode.window.activeTextEditor?.document === doc, Boolean)
  await until(
    () => doc.getText(vscode.window.activeTextEditor!.selection),
    (value) => value === '1777',
  )
  console.log(
    'PASS virtualized table, qualified fields, precise values, sorted/filtered identity, selection, and native source menu',
  )

  await vscode.commands.executeCommand('vscode.openWith', uri, 'gridkitStudio.network', {
    viewColumn: vscode.ViewColumn.Two,
    preview: false,
  })
  let split = await until(networks, (frames) => frames.length === 2)
  for (const frame of split) await ready(frame)
  await filter('')
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  const fieldContext = JSON.parse(
    (await table
      .getByRole('columnheader')
      .filter({ has: xHeader })
      .getAttribute('data-vscode-context'))!,
  )
  await xHeader.click({ button: 'right' })
  await workbench.getByRole('menuitem', { name: 'Bind to Network...', exact: true }).hover()
  await workbench.keyboard.press('Enter')
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vertex Color' })
    .click()
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-bindings'),
      (value) => !!value?.includes('vertexColor'),
    )
  assert.equal(await network.locator('main').innerText(), '')
  await vscode.commands.executeCommand('notifications.clearAll')
  const previousGrid = await table.locator('body').getAttribute('data-grid')
  const viewportNode = await table.getByRole('grid').elementHandle()
  const previousFocus = await table.locator('body').getAttribute('data-focus')
  await focus(network.locator('#network'))
  await network.locator('#network').press('Shift+F10')
  assert.equal(await workbench.getByRole('menuitem', { name: 'Network', exact: true }).count(), 0)
  await submenu('Show in')
  await workbench.getByRole('menuitem', { name: 'Case', exact: true }).waitFor()
  await workbench.screenshot({ path: join(output, 'network-element-menu.png') })
  await workbench.getByRole('menuitem', { name: 'Case', exact: true }).hover()
  await workbench.keyboard.press('Enter')
  await until(
    () => table.locator('body').getAttribute('data-focus'),
    (value) => !!value && value !== previousFocus,
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await until(
    () => table.locator('.data-row[aria-selected="true"]').getAttribute('data-index'),
    (value) => value === '1777',
  )
  await until(
    () =>
      table.evaluate(() =>
        (globalThis as unknown as { document: { hasFocus(): boolean } }).document.hasFocus(),
      ),
    Boolean,
  )
  assert.equal(await table.locator('body').getAttribute('data-grid'), previousGrid)
  assert.ok(
    await viewportNode!.evaluate((el) => el.isConnected && el === el.ownerDocument.activeElement),
  )
  console.log(
    'PASS persistent table viewport and native field binding, keyboard network context menu, and shared split-view selection/bindings',
  )

  const change = async (next: string) => {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      next,
    )
    assert.ok(await vscode.workspace.applyEdit(edit))
    await until(
      () => table.locator('body').getAttribute('data-version'),
      (version) => version === String(doc.version),
    )
    await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  }
  const pending = vscode.commands.executeCommand('gridkitStudio.bind', fieldContext)
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vertex Height' })
    .waitFor()
  const updated = JSON.parse(doc.getText())
  updated.header.case_comments = 'Revision changed during picker'
  await change(JSON.stringify(updated, null, 2))
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vertex Height' })
    .click()
  await pending
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-bindings'),
      (value) => value === 'vertexColor',
    )
  const before = await network.locator('#network').getAttribute('data-selected')
  await vscode.commands.executeCommand('gridkitStudio.reveal', rowContext)
  assert.equal(await network.locator('#network').getAttribute('data-selected'), before)
  console.log('PASS revision changes reject stale native targets and awaited binding pickers')

  const freshHeader = table.getByRole('button', { name: 'x (parameter)', exact: true })
  const freshTarget = JSON.parse(
    (await table
      .getByRole('columnheader')
      .filter({ has: freshHeader })
      .getAttribute('data-vscode-context'))!,
  )
  await vscode.commands.executeCommand('gridkitStudio.unbind', freshTarget)
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-bindings'),
      (value) => value === '',
    )
  const binding = vscode.commands.executeCommand('gridkitStudio.bind', freshTarget)
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'Vertex Size' })
    .click()
  await binding
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-bindings'),
      (value) => value === 'vertexSize',
    )
  await filter('Needle bus')
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await table.locator('.data-row .identity').click()
  await vscode.commands.executeCommand('workbench.action.togglePanel')
  await vscode.commands.executeCommand('gridkitStudio.openTable', uri)
  table = (
    await until(
      () => find('#table .case-data'),
      (frames) => frames.length > 0,
    )
  )[0]
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  assert.equal(await table.locator('body').getAttribute('data-query'), 'Needle bus')
  assert.equal(await table.locator('.data-row').first().getAttribute('data-index'), '1777')
  console.log('PASS unbinding, rebinding, and table restoration')

  await filter('')
  await selectClass('Branch')
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  assert.equal(await table.locator('[role="grid"]').getAttribute('aria-rowcount'), '2000')
  await focus(table.getByRole('grid'))
  await table.getByRole('grid').press('End')
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await table.getByRole('grid').press('Enter')
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-selected'),
      (value) => value === 'edge:1998',
    )
  await vscode.commands.executeCommand('notifications.clearAll')
  const divider = (await table.getByRole('separator').first().boundingBox())!
  await workbench.mouse.move(divider.x + 2, divider.y + 10)
  await workbench.mouse.down()
  await workbench.mouse.move(divider.x + 352, divider.y + 10)
  await workbench.mouse.up()
  await table.getByRole('grid').evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  assert.ok(await table.getByRole('grid').evaluate((el) => el.scrollLeft > 0))
  await table.getByRole('grid').press('Home')
  await table.getByRole('grid').press('End')
  await table.getByRole('grid').press('Shift+F10')
  await submenu('Copy')
  await workbench.getByRole('menuitem', { name: 'Copy Reference', exact: true }).waitFor()
  await workbench.screenshot({ path: join(output, 'case-table-keyboard-menu.png') })
  await workbench.getByRole('menuitem', { name: 'Copy Reference', exact: true }).hover()
  await workbench.keyboard.press('Enter')
  await until(
    () => vscode.env.clipboard.readText(),
    (value) => value === 'branch[1998]',
  )
  const resize = table.getByRole('separator').first()
  const previousWidth = Number(await resize.getAttribute('aria-valuenow'))
  await focus(resize)
  await resize.press('ArrowRight')
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), previousWidth + 10)
  const columns = vscode.commands.executeCommand('gridkitStudio.chooseColumns')
  await workbench
    .locator('.quick-input-widget input:not([type="checkbox"]):visible')
    .first()
    .fill('top.class')
  await workbench
    .locator('.quick-input-list .monaco-list-row')
    .filter({ hasText: 'top.class' })
    .click()
  await workbench.keyboard.press('Enter')
  await columns
  await table.getByRole('grid').evaluate((el) => {
    el.scrollLeft = 0
  })
  await table.getByRole('button', { name: 'class', exact: true }).waitFor()
  const branchContext = JSON.parse(
    (await table.locator('.data-row[data-index="1998"]').getAttribute('data-vscode-context'))!,
  )
  await filter('branch-0')
  const other = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'other.case.json')
  await vscode.workspace.fs.writeFile(
    other,
    new TextEncoder().encode(caseText({ buses: [{ number: 99 }] })),
  )
  await vscode.commands.executeCommand('gridkitStudio.openTable', other)
  await until(
    () => table.locator('body').getAttribute('data-case'),
    (value) => value === other.toString(),
  )
  await vscode.commands.executeCommand('gridkitStudio.showInTable', branchContext)
  await until(
    () => table.locator('body').getAttribute('data-case'),
    (value) => value === uri.toString(),
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  assert.equal(await table.locator('body').getAttribute('data-class'), 'branch')
  assert.equal(await table.locator('body').getAttribute('data-query'), '')
  await table.getByRole('button', { name: 'class', exact: true }).waitFor()
  await vscode.commands.executeCommand('gridkitStudio.fromEndpoint', branchContext)
  await until(
    () => table.locator('body').getAttribute('data-class'),
    (value) => value === 'bus',
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  console.log(
    'PASS keyboard navigation across virtual windows, class switching, branch endpoints, and captured cross-case targets',
  )

  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup')
  await focus(split[1].locator('#network'))
  const projection = vscode.commands.executeCommand('gridkitStudio.projection')
  await workbench.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Tilt' }).click()
  await projection
  await until(
    () => split[1].locator('#network').getAttribute('aria-label'),
    (value) => !!value?.includes('tilt projection'),
  )
  assert.match((await network.locator('#network').getAttribute('aria-label'))!, /flat projection/)
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup')
  await focus(split[1].locator('#network'))
  const options = vscode.commands.executeCommand('gridkitStudio.options')
  const optionInput = workbench
    .locator('.quick-input-widget input:not([type="checkbox"]):visible')
    .first()
  await optionInput.fill('Case colormap')
  await optionInput.press('Enter')
  await workbench
    .locator('.quick-input-title')
    .filter({ hasText: 'Case Colormap: Network and Monitor' })
    .waitFor()
  await optionInput.fill('Cividis')
  await optionInput.press('Enter')
  await options
  await split[1].locator('body[data-state="ready"]').waitFor()
  console.log('PASS independent split-view projections and native renderer options')
  await table.getByRole('button', { name: 'number', exact: true }).click()
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await focus(table.getByRole('grid'))
  await table.getByRole('grid').press('Home')
  await until(
    () => table.locator('.data-row').first().getAttribute('data-index'),
    (value) => value === '0',
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await table.getByRole('grid').press('Enter')
  await until(
    () => network.locator('#network').getAttribute('data-selected'),
    (value) => value === 'vertex:0',
  )
  await vscode.commands.executeCommand('notifications.clearAll')
  await focus(table.getByRole('grid'))
  await table.locator('#table').screenshot({ path: join(output, 'case-table-focused.png') })
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup')
  await vscode.commands.executeCommand('notifications.clearAll')
  await table.locator('#table').screenshot({ path: join(output, 'case-table-dark.png') })
  await workbench.screenshot({ path: join(output, 'studio-integrated.png') })
  const viewport = workbench.viewportSize()
  await workbench.setViewportSize({ width: 640, height: 720 })
  await table.locator('#table').screenshot({ path: join(output, 'case-table-narrow.png') })
  await workbench.setViewportSize(viewport ?? { width: 1280, height: 900 })
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
  await until(
    () => table.locator('body').getAttribute('class'),
    (value) => !!value?.includes('vscode-light'),
  )
  await table.locator('#table').screenshot({ path: join(output, 'case-table-light.png') })
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', 'Default High Contrast', vscode.ConfigurationTarget.Global)
  await until(
    () => table.locator('body').getAttribute('class'),
    (value) => !!value?.includes('vscode-high-contrast'),
  )
  await table.locator('#table').screenshot({ path: join(output, 'case-table-contrast.png') })
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global)
  const status = workbench.locator('.statusbar-item').filter({ hasText: 'Bus 0' })
  await focus(table.getByRole('grid'))
  await status.waitFor()
  const unrelated = await vscode.workspace.openTextDocument({
    content: 'Unrelated notes',
    language: 'plaintext',
  })
  await vscode.window.showTextDocument(unrelated, { viewColumn: vscode.ViewColumn.Beside })
  await status.waitFor({ state: 'hidden' })
  await focus(table.getByRole('grid'))
  await status.waitFor()
  await workbench.screenshot({ path: join(output, 'element-status.png') })
  console.log('PASS contextual status bar hides for unrelated editors and returns with table focus')
  const removed = JSON.parse(doc.getText())
  for (const bus of removed.buses) delete bus.params.x
  await change(JSON.stringify(removed, null, 2))
  for (const frame of split)
    await until(
      () => frame.locator('#network').getAttribute('data-bindings'),
      (value) => value === '',
    )
  assert.equal(await table.getByRole('button', { name: 'x (parameter)', exact: true }).count(), 0)
  console.log(
    'PASS document edits reconcile removed fields and bindings; dark/light/high-contrast captures',
  )
  await doc.save()
  const stableViewport = await table.getByRole('grid').elementHandle()
  const wide = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'wide.case.json')
  await vscode.workspace.fs.writeFile(
    wide,
    new TextEncoder().encode(
      caseText({
        buses: Array.from({ length: 10000 }, (_, i) => ({
          number: i,
          params: Object.fromEntries(
            Array.from({ length: 64 }, (_, j) => ['metric_' + j, i + j / 100]),
          ),
        })),
      }),
    ),
  )
  await vscode.commands.executeCommand('gridkitStudio.openTable', wide)
  await until(
    () => table.locator('body').getAttribute('data-case'),
    (value) => value === wide.toString(),
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  assert.ok(await stableViewport!.evaluate((el) => el.isConnected))
  assert.equal(await table.getByRole('grid').getAttribute('aria-rowcount'), '10001')
  assert.ok(Number(await table.getByRole('grid').getAttribute('aria-colcount')) >= 65)
  assert.ok((await table.getByRole('columnheader').count()) < 20)
  assert.ok((await table.getByRole('gridcell').count()) < 2000)
  await table.getByRole('grid').evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
  await table.getByRole('button', { name: 'metric_63', exact: true }).waitFor()
  await focus(table.getByRole('grid'))
  await table.getByRole('grid').press('End')
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await until(
    () => table.locator('.data-row[data-index="9999"]').innerText(),
    (value) => value.includes('9999.63'),
  )
  assert.ok((await table.getByRole('columnheader').count()) < 20)
  await table.locator('.data-row[data-index="9999"] [role="gridcell"]').last().click()
  await table.locator('.data-row[data-index="9999"][aria-selected="true"]').waitFor()
  await table.locator('#table').screenshot({ path: join(output, 'case-table-wide.png') })
  await vscode.commands.executeCommand('gridkitStudio.openTable', other)
  await until(
    () => table.locator('body').getAttribute('data-case'),
    (value) => value === other.toString(),
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  await vscode.commands.executeCommand('gridkitStudio.openTable', wide)
  await until(
    () => table.locator('body').getAttribute('data-case'),
    (value) => value === wide.toString(),
  )
  await table.locator('[role="grid"][aria-busy="false"]').waitFor()
  assert.ok(await table.getByRole('grid').evaluate((el) => el.scrollTop > 250000))
  await table.getByRole('button', { name: 'metric_63', exact: true }).waitFor()
  console.log(
    'PASS restored per-case scroll and bounded row and column rendering on a 10,000-row, 64-value-column case and persistent viewport rebinding',
  )
}
