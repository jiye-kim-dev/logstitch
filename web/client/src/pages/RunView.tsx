import { useEffect, useState } from 'react'
import { getRun, type RunDetail, type ViewRecord } from '../api.ts'

/** UTC HH:MM:SS.mmm — cli 텍스트 출력과 같은 표기 (물려받은 시각은 ~ 접두). */
function fmtTs(record: ViewRecord): string {
  if (record.ts === null) return '--:--:--.---'
  const stamp = record.ts.slice(11, 23)
  return record.tsInherited ? `~${stamp}` : stamp
}

export default function RunView({ id }: { id: string }): React.JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [collapse, setCollapse] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setDetail(null)
    getRun(id, collapse)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [id, collapse])

  if (error !== '') return <p className="error">{error}</p>
  if (detail === null) return <p className="dim">불러오는 중…</p>

  const shown = detail.criteria.map((c) => `${c.field}=${c.value}`).join(' AND ')
  const failed = detail.hosts.filter((h) => h.status !== 'ok')

  return (
    <>
      <section className="run-head">
        <h2>
          {detail.app} <span className="dim">/ {detail.environment}</span>
        </h2>
        <p className="dim">
          {shown} · {detail.records.length}줄 · 호스트 {detail.hosts.length}대
          {failed.length > 0 && <span className="error"> (실패 {failed.length})</span>}
          {detail.malformed > 0 && ` · 못 읽은 줄 ${detail.malformed}`}
        </p>
        <label>
          <input
            type="checkbox"
            checked={collapse}
            onChange={(e) => setCollapse(e.target.checked)}
          />
          반복 줄 접기
        </label>
      </section>

      {failed.length > 0 && (
        <ul className="host-fail">
          {failed.map((h) => (
            <li key={`${h.area}/${h.host}`}>
              {h.area}/{h.host}: {h.status} {h.error ?? ''}
            </li>
          ))}
        </ul>
      )}

      <table className="records">
        <tbody>
          {detail.records.map((r) => (
            <tr key={`${r.host}-${r.file}-${r.seq}`} className={r.isJson ? '' : 'raw-line'}>
              <td className="ts">{fmtTs(r)}</td>
              <td>{r.area}</td>
              <td>{r.host}</td>
              <td className={`level level-${r.level}`}>{r.level}</td>
              <td className="msg">
                {r.isJson ? r.msg : r.raw}
                {r.repeat > 1 && <span className="repeat"> ⟲ {r.repeat}회</span>}
                {r.caller !== '' && <span className="dim"> ({r.caller})</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
