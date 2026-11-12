/** Approval mode and external-connection settings: both are authorization scope, editable only from the management panel. */
import type { Settings } from '../policy.ts'
import { Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { SaveBar } from './draft.tsx'
import { Hint, Section } from './widgets.tsx'

type Approval = Settings['approval']
type Connections = Settings['connections']
type Connection = Connections['connections'][number]

const MODES = ['auto', 'ask', 'off'] as const
const KINDS = ['mail', 'calendar', 'files'] as const
type Kind = typeof KINDS[number]

const splitList = (text: string): string[] => text.split(/[\s,]+/).map(item => item.trim()).filter(Boolean)
/** Parse the draft form back into connector configs, dropping empty servers so a half-filled row does not 400. */
const assemble = (rows: EditableConnection[], readOnly: boolean): Connections => ({
  readOnly,
  connections: rows.filter(row => row.server.trim()).map(row => ({
    kind: row.kind,
    server: row.server.trim(),
    readTools: splitList(row.readTools),
    ...(row.writeTools.trim() ? { writeTools: splitList(row.writeTools) } : {}),
  })),
})
interface EditableConnection { kind: Kind; server: string; readTools: string; writeTools: string }

export function ApprovalSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = blocks.approval.value
  const draft = useBlockDraft<Approval>('approval', saved, blocks.approval.revision, value => value)
  const value = draft.value
  const edit = (next: Partial<Approval>) => draft.edit({ ...value, ...next })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('approvalMode')}<Hint>{t('approvalIntro')}</Hint></h2>
          <Section title={t('approvalMode')} hint={t('approvalModeHint')}>
            <div className="dt-form">
              {MODES.map(mode => <label key={mode} style={{ display: 'block' }}>
                <input type="radio" name="approval-mode" value={mode} checked={value.mode === mode}
                  onChange={() => edit({ mode })} /> {t(`approvalMode.${mode}`)}
              </label>)}
            </div>
          </Section>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  </div>
}

export function ConnectionsSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = blocks.connections.value
  const toRows = (config: Connections) => config.connections.map(row => ({ kind: row.kind, server: row.server,
    readTools: row.readTools.join(', '), writeTools: (row.writeTools ?? []).join(', ') }))
  const draft = useBlockDraft<{ readOnly: boolean; rows: EditableConnection[] }>('connections',
    { readOnly: saved.readOnly, rows: toRows(saved) }, blocks.connections.revision,
    value => assemble(value.rows, value.readOnly))
  const { readOnly, rows } = draft.value
  const edit = (next: Partial<{ readOnly: boolean; rows: EditableConnection[] }>) => draft.edit({ readOnly, rows, ...next })
  const setRow = (index: number, patch: Partial<EditableConnection>) => edit({ rows: rows.map((row, at) => at === index ? { ...row, ...patch } : row) })
  const addRow = () => edit({ rows: [...rows, { kind: 'mail', server: '', readTools: '', writeTools: '' }] })
  const removeRow = (index: number) => edit({ rows: rows.filter((_, at) => at !== index) })
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('connectionsIntro')}</h2>
          <Field label={t('connectionsReadOnly')} hint={t('connectionsReadOnlyHint')}>
            <Input type="checkbox" checked={readOnly} onChange={event => edit({ readOnly: event.target.checked })} />
          </Field>
          {rows.length === 0 && <Hint>{t('connectionsEmpty')}</Hint>}
          {rows.map((row, index) => <div key={index} className="dt-form dt-block">
            <Field label={t('connectionKind')}>
              <select value={row.kind} onChange={event => setRow(index, { kind: event.target.value as Kind })}>
                {KINDS.map(kind => <option key={kind} value={kind}>{t(`connectionKind.${kind}`)}</option>)}
              </select>
            </Field>
            <Field label={t('connectionServer')}>
              <Input value={row.server} placeholder="mail" spellCheck={false}
                onChange={event => setRow(index, { server: event.target.value })} />
            </Field>
            <Field label={t('connectionReadTools')}>
              <Input value={row.readTools} placeholder="list_messages, read_message" spellCheck={false}
                onChange={event => setRow(index, { readTools: event.target.value })} />
            </Field>
            <Field label={t('connectionWriteTools')}>
              <Input value={row.writeTools} placeholder="send_message" spellCheck={false}
                onChange={event => setRow(index, { writeTools: event.target.value })} />
            </Field>
            <button type="button" className="dt-textlink" onClick={() => removeRow(index)}>{t('connectionRemove')}</button>
          </div>)}
          <button type="button" className="dt-textlink" onClick={addRow}>{t('connectionAdd')}</button>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  </div>
}
