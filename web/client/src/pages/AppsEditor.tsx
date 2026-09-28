import { useEffect, useMemo, useRef, useState } from 'react'
import { getApps, putApps } from '../api.ts'
import { emptyApp, parseDraft, serializeDraft, validate, type AppDraft, type Draft } from '../appsModel.ts'
import AppCard, { Segmented } from './AppCard.tsx'

type Mode = 'form' | 'json'
type Status = { kind: 'ok' | 'error'; text: string } | null

const EMPTY = '{\n  "apps": {\n  }\n}\n'

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function AppsEditor(): React.JSX.Element {
  const [path, setPath] = useState('')
  const [missing, setMissing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [mode, setMode] = useState<Mode>('form')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [jsonText, setJsonText] = useState('')
  /** 마지막으로 저장(또는 로드)된 직렬화 텍스트 — dirty 판정 기준 */
  const [baseline, setBaseline] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [saving, setSaving] = useState(false)
  const [focusId, setFocusId] = useState<number | null>(null)

  useEffect(() => {
    getApps()
      .then((res) => {
        setPath(res.path)
        setMissing(res.text === null)
        const raw = res.text ?? EMPTY
        try {
          const d = parseDraft(raw)
          const s = serializeDraft(d)
          setDraft(d)
          setJsonText(s)
          // 로드 직후엔 폼 직렬화 결과를 기준으로 삼아야 포맷 차이만으로 dirty 가 안 뜬다
          setBaseline(res.text === null ? '' : s)
          setMode('form')
        } catch (err) {
          setJsonText(raw)
          setBaseline(raw)
          setMode('json')
          setStatus({ kind: 'error', text: `폼으로 열 수 없어 JSON 모드로 열었습니다 — ${msg(err)}` })
        }
      })
      .catch((err: unknown) => setStatus({ kind: 'error', text: msg(err) }))
      .finally(() => setLoaded(true))
  }, [])

  const problems = useMemo(() => (draft === null ? null : validate(draft)), [draft])
  const current = mode === 'form' && draft !== null ? serializeDraft(draft) : jsonText
  const dirty = loaded && current !== baseline

  const edit = (fn: (d: Draft) => Draft): void => {
    setDraft((d) => (d === null ? d : fn(d)))
    setStatus(null)
  }
  const editApp = (id: number, next: AppDraft): void =>
    edit((d) => ({ ...d, apps: d.apps.map((a) => (a.id === id ? next : a)) }))
  const addApp = (): void => {
    const a = emptyApp()
    edit((d) => ({ ...d, apps: [...d.apps, a] }))
    setFocusId(a.id)
  }
  const removeApp = (id: number): void => edit((d) => ({ ...d, apps: d.apps.filter((a) => a.id !== id) }))
  const moveApp = (index: number, delta: number): void =>
    edit((d) => {
      const j = index + delta
      if (j < 0 || j >= d.apps.length) return d
      const apps = [...d.apps]
      ;[apps[index], apps[j]] = [apps[j] as AppDraft, apps[index] as AppDraft]
      return { ...d, apps }
    })

  const switchMode = (next: Mode): void => {
    if (next === mode) return
    if (next === 'json') {
      if (draft !== null) setJsonText(serializeDraft(draft))
      setMode('json')
      setStatus(null)
      return
    }
    try {
      setDraft(parseDraft(jsonText))
      setMode('form')
      setStatus(null)
    } catch (err) {
      setStatus({ kind: 'error', text: `폼으로 전환할 수 없습니다 — ${msg(err)}` })
    }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    let text: string
    if (mode === 'form') {
      if (draft === null || problems === null) return
      if (problems.count > 0) {
        setStatus({ kind: 'error', text: `${problems.count}개 항목을 확인하세요` })
        return
      }
      text = serializeDraft(draft)
    } else {
      try {
        JSON.parse(jsonText) // 서버까지 안 가고 문법 오류를 즉시 알려준다
      } catch (err) {
        setStatus({ kind: 'error', text: `JSON 문법 오류: ${msg(err)}` })
        return
      }
      text = jsonText
    }
    setSaving(true)
    try {
      await putApps(text)
      setBaseline(text)
      setMissing(false)
      setStatus({ kind: 'ok', text: '저장됨' })
    } catch (err) {
      setStatus({ kind: 'error', text: msg(err) })
    } finally {
      setSaving(false)
    }
  }

  // ⌘S / Ctrl+S — 리스너는 한 번만 달고 최신 save 는 ref 로 참조한다
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent): void => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  if (!loaded) return <p className="dim">불러오는 중…</p>

  return (
    <>
      <section className="run-head apps-head">
        <div>
          <h2>apps.json</h2>
          <p className="dim">
            {path}
            {missing && ' — 파일이 아직 없습니다. 저장하면 생성됩니다.'}
          </p>
        </div>
        <Segmented
          value={mode}
          options={[
            { value: 'form', label: '폼' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={switchMode}
        />
      </section>

      {mode === 'form' && draft !== null && problems !== null ? (
        <>
          <section className="panel">
            <label className="panel-title" htmlFor="apps-comment">
              _comment
              <span className="dim">사람용 주석 — 한 줄이 배열 원소 하나, 빈 줄은 ""</span>
            </label>
            <textarea
              id="apps-comment"
              className="comment-box"
              rows={Math.min(Math.max(draft.comment.split('\n').length, 3), 14)}
              value={draft.comment}
              spellCheck={false}
              placeholder="이 파일에 대한 설명"
              onChange={(e) => {
                const comment = e.target.value
                edit((d) => ({ ...d, comment }))
              }}
            />
          </section>

          <section>
            <div className="apps-toolbar">
              <h3>
                apps <span className="count">{draft.apps.length}</span>
              </h3>
              <button type="button" className="add-btn" onClick={addApp}>
                + 앱 추가
              </button>
            </div>

            {problems.global.map((p) => (
              <p key={p} className="global-problem">
                {p}
              </p>
            ))}

            {draft.apps.length === 0 ? (
              <div className="empty">
                등록된 앱이 없습니다.
                <br />
                <button type="button" className="add-btn" onClick={addApp}>
                  + 첫 앱 추가
                </button>
              </div>
            ) : (
              <div className="app-list">
                {draft.apps.map((a, i) => (
                  <AppCard
                    key={a.id}
                    app={a}
                    index={i}
                    count={draft.apps.length}
                    problems={problems.byApp.get(a.id) ?? []}
                    autoFocus={a.id === focusId}
                    onChange={(next) => editApp(a.id, next)}
                    onMove={(delta) => moveApp(i, delta)}
                    onRemove={() => removeApp(a.id)}
                  />
                ))}
                <button type="button" className="add-btn add-btn-wide" onClick={addApp}>
                  + 앱 추가
                </button>
              </div>
            )}
          </section>
        </>
      ) : (
        <textarea
          className="apps-editor"
          value={jsonText}
          spellCheck={false}
          onChange={(e) => {
            setJsonText(e.target.value)
            setStatus(null)
          }}
        />
      )}

      <div className="editor-actions sticky">
        <button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? '저장 중…' : '저장'}
        </button>
        {dirty && <span className="dirty">● 저장 안 된 변경</span>}
        {status !== null && <span className={status.kind}>{status.text}</span>}
        <span className="dim kbd-hint">⌘S</span>
      </div>
    </>
  )
}
