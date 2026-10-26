import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderJsonl, renderSummary } from '../src/render.ts'
import type { Criterion, HostResult, LogRecord } from '../src/types.ts'

function summaryLines(criteria: Criterion[], truncated: boolean): string[] {
  const hosts: HostResult[] = [
    { area: 'main', host: 'kw41', status: 'ok', lineCount: 10, truncated, elapsedMs: 1 },
  ]
  const lines: string[] = []
  renderSummary(
    [],
    hosts,
    { app: 'ai-stt', environment: 'prod', areaOrder: ['main'], color: false, criteria },
    (line) => lines.push(line),
  )
  return lines
}

describe('renderSummary 다중 값 잘림 안내', () => {
  it('값 여러 개 조회가 잘리면 required 필드 값을 나눠 요청하라고 안내한다', () => {
    const out = summaryLines([{ field: 'rid', value: 'a', values: ['a', 'b', 'c'] }], true)
    assert.ok(
      out.some((l) => l.includes('rid 의 값 3개') && l.includes('나눠 다시 요청')),
      out.join('\n'),
    )
  })

  it('값이 하나면 기존 잘림 경고만 나온다', () => {
    const out = summaryLines([{ field: 'rid', value: 'a' }], true)
    assert.ok(out.some((l) => l.includes('줄 수 상한')))
    assert.ok(!out.some((l) => l.includes('나눠 다시 요청')))
  })

  it('잘리지 않으면 안내하지 않는다', () => {
    const out = summaryLines([{ field: 'rid', value: 'a', values: ['a', 'b'] }], false)
    assert.ok(!out.some((l) => l.includes('나눠 다시 요청')))
  })

  it('값 여러 개 조건은 머리글에 집합으로 표시한다', () => {
    const out = summaryLines(
      [
        { field: 'rid', value: 'a', values: ['a', 'b'] },
        { field: 'level', value: 'error' },
      ],
      false,
    )
    assert.ok(out.some((l) => l.includes('rid ∈ {a, b} AND level=error')), out.join('\n'))
  })
})

describe('renderJsonl 다중 값', () => {
  const rec = (over: Partial<LogRecord>): LogRecord =>
    ({ ts: null, match: { kind: 'field' }, fields: {}, ...over }) as LogRecord
  const jsonl = (r: LogRecord): Record<string, unknown> => {
    const lines: string[] = []
    renderJsonl([r], (line) => lines.push(line))
    return JSON.parse(lines[0]!) as Record<string, unknown>
  }

  it('걸린 값(matchedValue)을 실어 보낸다', () => {
    assert.equal(jsonl(rec({ matchedValue: 'b' }))['matchedValue'], 'b')
  })

  it('값이 하나면 키 자체가 없다 — 기존 출력 그대로', () => {
    assert.equal('matchedValue' in jsonl(rec({})), false)
  })
})
