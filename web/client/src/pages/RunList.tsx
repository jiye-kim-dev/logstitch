import { useEffect, useState } from 'react'
import { getRuns, type RunsResponse } from '../api.ts'

function formatOpts(opts?: string[] | null): string {
    if (!opts || opts.length === 0) return '—';

    const parts: string[] = [];
    for (let i = 0; i < opts.length; i++) {
        const cur = opts[i];
        const next = opts[i + 1];

        // "--key value" 형태면 묶고 value는 건너뜀
        if (cur.startsWith('--') && next !== undefined && !next.startsWith('--')) {
            parts.push(`${cur}: ${next}`);
            i++;
        } else {
            // 값 없는 플래그(--verbose 등)나 단독 값은 그대로
            parts.push(cur);
        }
    }
    return parts.join(', ');
}

export default function RunList(): React.JSX.Element {
  const [data, setData] = useState<RunsResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getRuns()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (error !== '') return <p className="error">{error}</p>
  if (data === null) return <p className="dim">불러오는 중…</p>

  return (
    <>
      <section className="run-head">
        <h2>runs</h2>
        <p className="dim">{data.root}</p>
      </section>
      {data.runs.length === 0 ? (
        <p className="dim">
          수집 이력이 없습니다 — <code>logstitch … | logstitch-parse</code> 로 수집하면 여기 쌓입니다.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>run</th>
              <th>app</th>
              <th>env</th>
              <th>검색 조건</th>
              <th>Options</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <a href={`#/runs/${encodeURIComponent(run.id)}`}>{run.id}</a>
                </td>
                <td>{run.meta?.app ?? '—'}</td>
                <td>{run.meta?.env ?? '—'}</td>
                <td className="dim">
                  {run.meta === null ? ''
                    : Object.entries(run.meta.fields)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' AND ')}
                </td>
                  <td>{formatOpts(run.meta?.opts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
