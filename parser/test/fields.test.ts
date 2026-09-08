import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callerOf, parseEmbeddedJson, parseTs, pick, stripVolatile } from '../src/fields.ts'

describe('parseTs', () => {
  it('ISO Z 나노초 9자리를 나노초까지 보존한다', () => {
    // 이게 이 파일에서 가장 중요한 테스트다. JS Date 는 밀리초까지만 담으므로
    // 나노초를 따로 들고 있지 않으면 같은 밀리초 안의 인과 순서를 잃는다.
    const ts = parseTs('2026-09-04T02:19:24.568353422Z')
    assert.ok(ts !== null)
    assert.equal(ts.date.toISOString(), '2026-09-04T02:19:24.568Z')
    assert.equal(ts.nanos % 1_000_000n, 353_422n, '밀리초 이하 나노초가 보존되지 않았다')
  })

  it('공백 구분 + 오프셋 타임존을 읽는다', () => {
    const ts = parseTs('2026-09-04 02:19:26.000000 +00:00')
    assert.equal(ts?.date.toISOString(), '2026-09-04T02:19:26.000Z')
  })

  it('콜론 없는 오프셋(+0900)도 읽는다', () => {
    // Date.parse 는 ±HH:mm 만 보장한다. 콜론을 넣어주지 않으면 NaN 이 된다.
    const ts = parseTs('2026-09-04T11:19:26.000+0900')
    assert.equal(ts?.date.toISOString(), '2026-09-04T02:19:26.000Z')
  })

  it('타임존 표기가 없으면 UTC 로 본다', () => {
    const ts = parseTs('2026-09-04T02:19:26')
    assert.equal(ts?.date.toISOString(), '2026-09-04T02:19:26.000Z')
  })

  it('epoch 단위(초/밀리/마이크로/나노)를 크기로 판별한다', () => {
    const expected = '2026-09-04T02:19:29.123Z'
    assert.equal(parseTs(1788488369)?.date.toISOString(), '2026-09-04T02:19:29.000Z')
    assert.equal(parseTs('1788488369123')?.date.toISOString(), expected)
    assert.equal(parseTs('1788488369123000')?.date.toISOString(), expected)
    assert.equal(parseTs('1788488369123000000')?.date.toISOString(), expected)
  })

  it('숫자 문자열 epoch 은 나노초가 온전하다', () => {
    // 파이썬은 여기서 float 로 바꿔 정밀도를 잃는다. 문자열이면 BigInt 로 정확히 읽는다.
    const ts = parseTs('1788488369123456789')
    assert.equal(ts?.nanos, 1_788_488_369_123_456_789n)
  })

  it('범위를 벗어난 값과 빈 값은 null', () => {
    assert.equal(parseTs(''), null)
    assert.equal(parseTs(null), null)
    assert.equal(parseTs('not a time'), null)
    assert.equal(parseTs(12345), null)
  })
})

describe('pick', () => {
  it('별칭 목록 순서대로 처음 값이 있는 키를 고른다', () => {
    assert.deepEqual(pick({ time: 'a', ts: 'b' }, ['ts', 'time']), ['ts', 'b'])
    assert.deepEqual(pick({ time: 'a' }, ['ts', 'time']), ['time', 'a'])
  })

  it('null 과 빈 문자열은 없는 것으로 보되 0 과 false 는 유효하다', () => {
    assert.deepEqual(pick({ a: null, b: 0 }, ['a', 'b']), ['b', 0])
    assert.deepEqual(pick({ a: '', b: false }, ['a', 'b']), ['b', false])
  })
})

describe('callerOf', () => {
  it('Go slog 의 source 객체를 파일명:줄 로 줄인다', () => {
    // function 경로는 너무 길어서 버린다. 필요한 건 파일명과 줄 번호다.
    const caller = callerOf({
      source: { function: 'github.com/x/consumer.(*C).Handle', file: '/consumer/rabbitmq.go', line: 300 },
    })
    assert.equal(caller, 'rabbitmq.go:300')
  })

  it('zap 의 caller 문자열도 받는다', () => {
    assert.equal(callerOf({ caller: 'consumer/rabbitmq.go:412' }), 'rabbitmq.go:412')
  })

  it('없으면 빈 문자열', () => {
    assert.equal(callerOf({ msg: 'x' }), '')
  })
})

describe('parseEmbeddedJson', () => {
  it('JSON 문자열이 통째로 든 필드를 풀어준다', () => {
    const out = parseEmbeddedJson({
      body: '{"state":"STARTED","info":{"storage_key":"req_uid_rid-7f3a91.mp3"}}',
    }) as { body: { state: string; info: { storage_key: string } } }
    assert.equal(out.body.state, 'STARTED')
    assert.equal(out.body.info.storage_key, 'req_uid_rid-7f3a91.mp3')
  })

  it('JSON 처럼 생겼지만 아닌 문자열은 그대로 둔다', () => {
    const out = parseEmbeddedJson({ body: '{not json}' }) as { body: string }
    assert.equal(out.body, '{not json}')
  })
})

describe('stripVolatile', () => {
  it('중첩 구조 안의 타임스탬프 키까지 재귀적으로 제거한다', () => {
    const out = stripVolatile({
      ts: 'x',
      msg: 'keep',
      body: { timestamp: 'y', state: 'STARTED' },
    })
    assert.deepEqual(out, { msg: 'keep', body: { state: 'STARTED' } })
  })
})
