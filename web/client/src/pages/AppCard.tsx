import { useEffect, useRef, useState } from 'react'
import { PARSER_KEYS, type AppDraft, type LaneFallback, type ParserKey, type ViewDefault } from '../appsModel.ts'

// ── 공용 입력 ───────────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 문자열 배열 입력 — Enter/쉼표/공백으로 확정, 빈 칸에서 Backspace 로 마지막 삭제.
 * ordered 면 순서 번호와 좌우 이동 버튼을 붙인다 (required 는 grep 순서라 순서가 의미를 가짐).
 */
export function TokenInput({
  values,
  onChange,
  placeholder,
  ordered = false,
  invalid = false,
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ordered?: boolean
  invalid?: boolean
}): React.JSX.Element {
  const [pending, setPending] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (raw: string): void => {
    const add = [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()))].filter(
      (s) => s !== '' && !values.includes(s),
    )
    if (add.length > 0) onChange([...values, ...add])
    setPending('')
  }

  const move = (i: number, delta: number): void => {
    const j = i + delta
    if (j < 0 || j >= values.length) return
    const next = [...values]
    ;[next[i], next[j]] = [next[j] as string, next[i] as string]
    onChange(next)
  }

  return (
    <div className={`tokens${invalid ? ' invalid' : ''}`} onClick={() => inputRef.current?.focus()}>
      {values.map((v, i) => (
        <span key={v} className="token">
          {ordered && <span className="token-idx">{i + 1}</span>}
          <span>{v}</span>
          {ordered && values.length > 1 && (
            <>
              <button
                type="button"
                className="token-btn"
                title="앞으로"
                disabled={i === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  move(i, -1)
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className="token-btn"
                title="뒤로"
                disabled={i === values.length - 1}
                onClick={(e) => {
                  e.stopPropagation()
                  move(i, 1)
                }}
              >
                ›
              </button>
            </>
          )}
          <button
            type="button"
            className="token-btn"
            title="삭제"
            onClick={(e) => {
              e.stopPropagation()
              onChange(values.filter((x) => x !== v))
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={pending}
        spellCheck={false}
        placeholder={values.length === 0 ? placeholder : ''}
        onChange={(e) => {
          const v = e.target.value
          if (/[,\s]/.test(v)) commit(v)
          else setPending(v)
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(pending)
          } else if (e.key === 'Backspace' && pending === '' && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
        onBlur={() => commit(pending)}
      />
    </div>
  )
}

// ── 앱 카드 ─────────────────────────────────────────────────────────────────

const VIEW_OPTIONS: { value: ViewDefault | ''; label: string }[] = [
  { value: '', label: '미지정' },
  { value: 'timeline', label: 'timeline' },
  { value: 'flow', label: 'flow' },
  { value: 'contention', label: 'contention' },
]

const FALLBACK_OPTIONS: { value: LaneFallback | ''; label: string }[] = [
  { value: '', label: '미지정' },
  { value: 'host', label: 'host' },
  { value: 'source', label: 'source' },
]

const PARSER_LABELS: Record<ParserKey, { label: string; example: string }> = {
  tsKeys: { label: '타임스탬프', example: 'event_time' },
  levelKeys: { label: '레벨', example: 'sev' },
  msgKeys: { label: '메시지', example: 'description' },
  callerKeys: { label: '호출 위치', example: 'origin' },
}

function FieldName({ label, keyName }: { label: string; keyName: string }): React.JSX.Element {
  return (
    <div className="field-name">
      {label}
      <code>{keyName}</code>
    </div>
  )
}

export default function AppCard({
  app,
  index,
  count,
  problems,
  autoFocus,
  onChange,
  onMove,
  onRemove,
}: {
  app: AppDraft
  index: number
  count: number
  problems: string[]
  autoFocus: boolean
  onChange: (next: AppDraft) => void
  onMove: (delta: number) => void
  onRemove: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(t)
  }, [confirming])

  const setView = (patch: Partial<AppDraft['view']>): void =>
    onChange({ ...app, view: { ...app.view, ...patch } })
  const parserCount = PARSER_KEYS.reduce((n, k) => n + app.parser[k].length, 0)
  // details 의 open 은 처음 한 번만 정한다 — 값에 묶으면 마지막 칩을 지우는 순간 접혀버린다
  const [parserOpen] = useState(parserCount > 0)
  const [commentOpen] = useState(app.comment.trim() !== '')

  return (
    <section className={`app-card${problems.length > 0 ? ' has-error' : ''}`}>
      <header className="app-card-head">
        <input
          className="app-name"
          value={app.name}
          placeholder="앱 이름 (예: forwarder)"
          spellCheck={false}
          autoFocus={autoFocus}
          onChange={(e) => onChange({ ...app, name: e.target.value })}
        />
        <div className="app-card-actions">
          <button type="button" className="icon-btn" title="위로" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            title="아래로"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={`danger-btn${confirming ? ' confirming' : ''}`}
            onClick={() => (confirming ? onRemove() : setConfirming(true))}
          >
            {confirming ? '정말 삭제' : '삭제'}
          </button>
        </div>
      </header>

      {problems.length > 0 && (
        <ul className="app-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="app-body">
        <FieldName label="필수 필드" keyName="required" />
        <div>
          <TokenInput
            ordered
            values={app.required}
            invalid={app.required.length === 0}
            placeholder="필드명 입력 후 Enter (예: channel_key)"
            onChange={(required) => onChange({ ...app, required })}
          />
          <p className="hint">이 순서대로 원격 grep 을 잇는다 — 가장 선택적인 필드를 앞에 두면 전송량이 준다.</p>
        </div>

        <FieldName label="기본 뷰" keyName="view.default" />
        <div>
          <Segmented value={app.view.default} options={VIEW_OPTIONS} onChange={(v) => setView({ default: v })} />
          <p className="hint">--view 플래그 &gt; 이 힌트 &gt; 프로필 기본값 순으로 적용.</p>
        </div>

        <FieldName label="레인 / 세션" keyName="view.lane · session" />
        <div className="inline-fields">
          <label>
            lane
            <input
              className="text-input mono"
              value={app.view.lane}
              placeholder="server_id (없으면 host)"
              spellCheck={false}
              onChange={(e) => setView({ lane: e.target.value })}
            />
          </label>
          <label>
            session
            <input
              className="text-input mono"
              value={app.view.session}
              placeholder="trace_id"
              spellCheck={false}
              onChange={(e) => setView({ session: e.target.value })}
            />
          </label>
          <label>
            laneFallback
            <Segmented
              value={app.view.laneFallback}
              options={FALLBACK_OPTIONS}
              onChange={(v) => setView({ laneFallback: v })}
            />
          </label>
        </div>

        <FieldName label="메모" keyName="note" />
        <input
          className="text-input"
          value={app.note}
          placeholder="사람용 메모 — 코드는 쓰지 않음"
          onChange={(e) => onChange({ ...app, note: e.target.value })}
        />

        <details className="sub" open={parserOpen}>
          <summary>
            파서 별칭 <code>parser</code>
            {parserCount > 0 && <span className="count">{parserCount}</span>}
          </summary>
          <div className="sub-grid">
            {PARSER_KEYS.map((k) => (
              <div key={k} className="sub-row">
                <FieldName label={PARSER_LABELS[k].label} keyName={k} />
                <TokenInput
                  values={app.parser[k]}
                  placeholder={`예: ${PARSER_LABELS[k].example}`}
                  onChange={(v) => onChange({ ...app, parser: { ...app.parser, [k]: v } })}
                />
              </div>
            ))}
          </div>
          <p className="hint">표준 키(ts/level/msg 등)를 안 쓰는 앱용. 여기 지정한 키가 전역 별칭보다 먼저 잡힌다.</p>
        </details>

        <details className="sub" open={commentOpen}>
          <summary>
            앱 주석 <code>_comment</code>
          </summary>
          <textarea
            className="comment-box"
            rows={Math.min(Math.max(app.comment.split('\n').length, 2), 10)}
            value={app.comment}
            spellCheck={false}
            placeholder="한 줄이 배열 원소 하나"
            onChange={(e) => onChange({ ...app, comment: e.target.value })}
          />
        </details>
      </div>
    </section>
  )
}
