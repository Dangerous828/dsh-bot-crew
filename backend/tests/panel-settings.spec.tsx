// @vitest-environment jsdom
// The Settings groups, drafts, save bars and history.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Fields } from '../src/client/settings-kit.tsx'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Eval block on the Policy settings and the Executor with its execution environment on the Execution settings, each against its own revision', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh['mode.auto'])
  await type(field<HTMLInputElement>(zh.evalTimeout), '180')
  const [provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'worker-provider'); await type(model as HTMLInputElement, 'worker-model')
  await click(zh.save)
  expect(server.settings.eval).toEqual({ mode: 'auto', timeoutSeconds: 180, model: { provider: 'worker-provider', model: 'worker-model' } })
  await click(find(zh['promptPart.runtime/work'], '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // An empty root uses the default directory, which the field names instead of looking set.
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent).toBe('留空时用 /srv/dsh-superagent/work')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // A variable picked from the list goes where the caret is in the prepare command.
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录执行器', 'DSH_SUPERAGENT_NAME工单短名执行器',
    'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库GitHub · 已关闭'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model input')
  await type(workerProvider as HTMLInputElement, 'worker-provider'); await type(workerModel as HTMLInputElement,
    'worker-model'); await type(effort as HTMLInputElement, 'high')
  expect([...document.querySelectorAll('#dt-worker-model-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.executor).toEqual({ botModels: {}, maxWorkers: 5, directory: '/srv/work',
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', repositories: [], blockedCommands: ['gh-personal', 'gh.other'],
    model: { provider: 'worker-provider',
      model: 'worker-model', reasoningEffort: 'high' }, isolation: 'none' })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval',
    'settings/executor'])
})

it('adds a backup route to a role, saves it, and reads the same route back (#25)', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  // 备选是可选的：默认没有，页面上只有主路由三个输入。
  expect(all('.dt-model input')).toHaveLength(3)
  // 说明走全站一致的 (?) tooltip：主路由不通就退到这里，且明说保存即生效。
  expect(document.querySelector(`.dt-model .dt-info[aria-label="${zh.backupHint}"]`)).not.toBeNull()
  expect(text()).toContain(zh.backupEffect)
  await click(zh.backupAdd)
  const backup = () => ({
    provider: field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelProvider}`),
    model: field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelName}`),
    effort: field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelEffort}`),
  })
  // 与主路由同口径：服务商、模型、推理强度三个输入，建议列表也来自同一份模型目录。
  expect(backup().provider.getAttribute('list')).toBe('dt-eval-model-backup-providers')
  await type(backup().provider, 'worker-provider')
  await type(backup().model, 'worker-model')
  await type(backup().effort, 'high')
  await type(field<HTMLInputElement>(zh.modelProvider), 'primary-provider')
  await type(field<HTMLInputElement>(zh.modelName), 'primary-model')
  expect([...document.querySelectorAll('#dt-eval-model-backup-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.eval.model).toEqual({ provider: 'primary-provider', model: 'primary-model',
    backup: { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'high' } })
  // 读回：保存后服务端回来的值原样回到输入框，不丢也不串到主路由上。
  expect(field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelProvider}`).value).toBe('worker-provider')
  expect(field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelName}`).value).toBe('worker-model')
  expect(field<HTMLInputElement>(zh.modelProvider).value).toBe('primary-provider')
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval'])
})

it('removes a backup route from a role, saves it, and reads back a route with no backup (#25)', async () => {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, model: { provider: 'primary-provider',
    model: 'primary-model', backup: { provider: 'worker-provider', model: 'worker-model' } } } }
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  // 已有备选：表单直接展开，编辑入口与主路由一致。
  expect(field<HTMLInputElement>(`${zh.backupLabel} · ${zh.modelProvider}`).value).toBe('worker-provider')
  await click(zh.backupRemove)
  expect(all(`[aria-label="${zh.backupLabel}"]`)).toHaveLength(0)
  await click(zh.save)
  expect(server.settings.executor.model).toEqual({ provider: 'primary-provider', model: 'primary-model' })
  // 读回：服务端回来的路由没有 backup，表单也不再展开备选。
  expect(all(`[aria-label="${zh.backupLabel}"]`)).toHaveLength(0)
  expect(text()).toContain(zh.backupAdd)
})

it('loads configuration history on demand with localized changes, Source field labels and notified Tickets', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'sync', policyVersion: 'abcdef1234567890', policyChanged: true, notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
    changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceRowsAdded', source: 'feishu', field: 'allowed', items: ['Bob'],
      part: true }, { code: 'sourceField', source: 'feishu', field: 'syncChat', from: '', to: 'oc_team', part: true }] }] }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 从群同步', '生成策略版本 abcdef12', '接单模式：关闭 → 仅观察', '飞书 · 能发起工作的飞书用户 新增：Bob', '飞书 · 同步来源群：未设置 → oc_team',
    '因策略变更通知了 1 个进行中的工单：修复回归']) expect(text()).toContain(expected)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // A save submitted from a field keeps the focus there; one from the bar hands it to the block when the bar closes.
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
  await click(find(zh['term.source'], '.dt-settings-link'))
  expect(all('.dt-savebar')).toHaveLength(0)
  const github = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'GitHub')!
  await type(field<HTMLInputElement>('智能体的 GitHub CLI'), 'gh-other')
  expect(github.lastElementChild!.classList.contains('dt-savebar')).toBe(true)
  // The agent CLI is read by setup, so the bar warns that saving restarts dsh-superagent and interrupts running work.
  expect(github.lastElementChild!.textContent).toContain('2 个进行中的派工会中断')
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom does not blur a control when it becomes disabled; move focus away manually.
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('lists the settings groups stages first, opens each stage\'s group from its status, and returns to the last group opened',
  async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['来源', '评估', '执行', '审批与连接', '提示词', '部署'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  for (const [tab, group] of [['来源', '来源'], ['评估', '评估'], ['执行', '执行']] as const) {
    await click(find(tab, '[role="tab"]'))
    await click(find(zh['tab.settings'], '.dt-status-head button'))
    expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(group)
  }
  // The Trigger stage has no settings, so its status offers none.
  await click(tab(zh['tab.trigger']))
  expect(all('.dt-status-head button').map(button => button.textContent)).not.toContain(zh['tab.settings'])
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
  await click(tab(zh['tab.trigger']))
  await remount()
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['promptPart.runtime/work'])
})

it('edits the approval mode and external connections on the approval group, each block saved on its own revision', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.approval'], '.dt-settings-link'))
  // Approval: switch to 自动 (default is 询问), save the approval block. Only the mode is exposed; the budget threshold has no data source and is not in the UI.
  const autoRadio = all('label').find(label => label.textContent?.trim() === zh['approvalMode.auto'])!.querySelector('input')!
  await act(async () => { (autoRadio as HTMLInputElement).click() })
  await click(find(zh.save, '.dt-savebar button'))
  expect(server.settings.approval.mode).toBe('auto')
  // Connections: toggle read-only off, add a mail connector, save the connections block.
  await click(field<HTMLInputElement>(zh.connectionsReadOnly))
  await click(find(zh.connectionAdd))
  await type(field<HTMLInputElement>(zh.connectionServer), 'mail')
  await type(field<HTMLInputElement>(zh.connectionReadTools), 'list_messages, read_message')
  await type(field<HTMLInputElement>(zh.connectionWriteTools), 'send_message')
  await click(find(zh.save, '.dt-savebar button'))
  expect(server.settings.connections.readOnly).toBe(false)
  expect(server.settings.connections.connections).toEqual([{ kind: 'mail', server: 'mail', readTools: ['list_messages', 'read_message'], writeTools: ['send_message'] }])
})
