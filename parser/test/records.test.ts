import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FAR_FUTURE_NANOS } from '../src/fields.ts'
import { Normalizer, classifyMatch, collapseRuns } from '../src/records.ts'
import type { LineEvent, LogRecord } from '../src/types.ts'

const RID = 'rid-7f3a91'

function lineEvent(line: string, over: Partial<LineEvent> = {}): LineEvent {
  return {
    type: 'line',
    area: 'requester',
    host: 'kw41',
    source: 'app',
    file: 'requester.log',
    line,
    ...over,
  }
}

function sortRecords(records: LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => {
    const an = a.ts?.nanos ?? FAR_FUTURE_NANOS
    const bn = b.ts?.nanos ?? FAR_FUTURE_NANOS
    if (an !== bn) return an < bn ? -1 : 1
    if (a.host !== b.host) return a.host < b.host ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.seq - b.seq
  })
}

describe('classifyMatch', () => {
  it('찾던 필드에 정확히 그 값이면 field', () => {
    assert.deepEqual(classifyMatch(true, { rid: RID }, 'rid', RID), { kind: 'field' })
  })

  it('중첩 구조 안에 값이 그대로 있으면 nested', () => {
    assert.deepEqual(classifyMatch(true, { meta: { ids: [RID] } }, 'rid', RID), {
      kind: 'nested',
      path: 'meta.ids[0]',
    })
  })

  it('더 긴 값 안에 포함되면 partial', () => {
    // 실제로 어떤 receiver 는 rid 필드에 핸들러 이름을 넣고 진짜 rid 를
    // form_data 안에 "<rid>.mp3" 로 넣는다. 그 줄이 요청을 처음 받은
    // 시점의 원본 파라미터 로그라 버리면 안 된다.
    assert.deepEqual(
      classifyMatch(
        true,
        { rid: 'HandleSubtitle', form_data: { source_file_name: [`${RID}.mp3`] } },
        'rid',
        RID,
      ),
      { kind: 'partial', path: 'form_data.source_file_name[0]' },
    )
  })

  it('다른 최상위 필드에 같은 값이면 other', () => {
    assert.deepEqual(classifyMatch(true, { rid: 'x', parent_rid: RID }, 'rid', RID), {
      kind: 'other',
      key: 'parent_rid',
    })
  })

  it('위치를 특정 못 하면 substring', () => {
    assert.deepEqual(classifyMatch(true, { msg: 'nothing here' }, 'rid', RID), {
      kind: 'substring',
    })
  })

  it('JSON 이 아닌 줄은 raw — 항상 살린다', () => {
    assert.deepEqual(classifyMatch(false, {}, 'rid', RID), { kind: 'raw' })
  })
})

describe('Normalizer', () => {
  it('JSON 이 아닌 줄을 버리지 않고 직전 줄의 시각을 물려준다', () => {
    // panic, 스택트레이스, 기동 배너는 장애 시점에 제일 보고 싶은 줄이다.
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const first = n.push(
      lineEvent(`{"time":"2026-09-04T02:19:24.100000000Z","msg":"before","rid":"${RID}"}`),
    )
    const panic = n.push(lineEvent(`panic: boom ${RID}`))

    assert.equal(panic.isJson, false)
    assert.equal(panic.tsInherited, true)
    assert.equal(panic.ts?.nanos, first.ts?.nanos)
    assert.equal(panic.msg, `panic: boom ${RID}`, '원본 줄이 메시지로 남아야 한다')
  })

  it('스트림(호스트+파일)별로 seq 를 센다', () => {
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const a1 = n.push(lineEvent('x', { host: 'kw41' }))
    const b1 = n.push(lineEvent('x', { host: 'kw42' }))
    const a2 = n.push(lineEvent('x', { host: 'kw41' }))

    assert.deepEqual([a1.seq, b1.seq, a2.seq], [1, 1, 2])
  })

  it('실제로 쓴 별칭 키만 usedKeys 에 담는다', () => {
    // 별칭 목록 전체를 빼면 msg 와 event 가 같이 있는 줄에서
    // event 객체가 통째로 사라진다 (event 는 MSG_KEYS 의 별칭이라서).
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const rec = n.push(
      lineEvent('{"time":"2026-09-04T02:19:24Z","msg":"m","event":{"kind":"k"},"rid":"r"}'),
    )
    assert.deepEqual(rec.usedKeys, ['msg', 'time'])
    assert.ok(!rec.usedKeys.includes('event'), 'event 가 회색 줄에서 사라진다')
  })
})

describe('나노초 정렬', () => {
  it('같은 밀리초 안에서도 나노초로 순서가 잡힌다', () => {
    // 파이썬 구현은 마이크로초까지만 다뤄서 이 구분을 못 한다.
    // Date 로만 정렬하면 두 줄이 동순위가 되어 seq(파일 내 순서)로 떨어지고,
    // 서로 다른 호스트의 줄이면 인과 순서가 뒤집힌다.
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const later = n.push(
      lineEvent(`{"time":"2026-09-04T02:19:24.568999999Z","msg":"later","rid":"${RID}"}`, {
        host: 'kw41',
      }),
    )
    const earlier = n.push(
      lineEvent(`{"time":"2026-09-04T02:19:24.568000001Z","msg":"earlier","rid":"${RID}"}`, {
        host: 'kw42',
      }),
    )

    assert.equal(
      later.ts?.date.toISOString(),
      earlier.ts?.date.toISOString(),
      '두 줄은 밀리초까지 같아야 이 테스트가 의미 있다',
    )

    const sorted = sortRecords([later, earlier])
    assert.deepEqual(
      sorted.map((r) => r.msg),
      ['earlier', 'later'],
    )
  })

  it('시각을 못 읽은 줄은 맨 뒤로 간다', () => {
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const noTs = n.push(lineEvent(`starting up ${RID}`))
    const withTs = n.push(
      lineEvent(`{"time":"2026-09-04T02:19:24Z","msg":"m","rid":"${RID}"}`, {
        file: 'other.log',
      }),
    )
    // noTs 가 먼저 왔지만 물려받을 시각이 없으므로 ts 는 null 이다.
    assert.equal(noTs.ts, null)
    assert.deepEqual(
      sortRecords([noTs, withTs]).map((r) => r.msg),
      ['m', `starting up ${RID}`],
    )
  })
})

describe('collapseRuns', () => {
  it('키 순서가 달라도 같은 내용으로 접는다', () => {
    // 이게 이식에서 조용히 깨지는 지점이다. 파이썬은
    // json.dumps(sort_keys=True) 로 지문을 만드는데 JSON.stringify 에는
    // 그런 옵션이 없다. 그냥 stringify 하면 같은 내용인데 지문이 갈리고
    // 반복 접기가 아무 에러 없이 안 먹는다.
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const a = n.push(
      lineEvent(`{"ts":"2026-09-04T02:19:26Z","msg":"poll","rid":"${RID}","state":"STARTED"}`),
    )
    const b = n.push(
      lineEvent(`{"state":"STARTED","rid":"${RID}","msg":"poll","ts":"2026-09-04T02:19:27Z"}`),
    )

    assert.equal(a.sig, b.sig, '키 순서 때문에 지문이 갈렸다')

    const kept = collapseRuns([a, b])
    assert.equal(kept.length, 1)
    assert.equal(kept[0]?.repeat, 2)
  })

  it('상태가 바뀌면 접지 않는다', () => {
    // msg 만 보고 접으면 STARTED → SUCCESS 전이까지 뭉개지는데,
    // 그게 정작 제일 보고 싶은 줄이다.
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const started = n.push(
      lineEvent(`{"ts":"2026-09-04T02:19:26Z","msg":"poll","rid":"${RID}","state":"STARTED"}`),
    )
    const success = n.push(
      lineEvent(`{"ts":"2026-09-04T02:19:31Z","msg":"poll","rid":"${RID}","state":"SUCCESS"}`),
    )

    assert.equal(collapseRuns([started, success]).length, 2)
  })

  it('중간에 다른 이벤트가 끼면 거기서 끊긴다', () => {
    // "폴링하다가 뭔가 일어나고 다시 폴링" 이 한 덩어리로 뭉개지지 않아야 한다.
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const poll = (ts: string) =>
      n.push(lineEvent(`{"ts":"${ts}","msg":"poll","rid":"${RID}"}`))
    const other = n.push(lineEvent(`{"ts":"2026-09-04T02:19:28Z","msg":"boom","rid":"${RID}"}`))

    const kept = collapseRuns([
      poll('2026-09-04T02:19:26Z'),
      poll('2026-09-04T02:19:27Z'),
      other,
      poll('2026-09-04T02:19:29Z'),
    ])
    assert.deepEqual(
      kept.map((r) => [r.msg, r.repeat ?? 1]),
      [
        ['poll', 2],
        ['boom', 1],
        ['poll', 1],
      ],
    )
  })

  it('다른 호스트의 같은 줄은 접지 않는다', () => {
    const n = new Normalizer({ app: 'sample', environment: 'test', field: 'rid', value: RID })
    const body = `{"ts":"2026-09-04T02:19:26Z","msg":"poll","rid":"${RID}"}`
    const kept = collapseRuns([
      n.push(lineEvent(body, { host: 'kw41' })),
      n.push(lineEvent(body, { host: 'kw42' })),
    ])
    assert.equal(kept.length, 2)
  })
})
