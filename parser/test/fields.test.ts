import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_ALIASES,
  callerOf,
  mergeAliases,
  parseEmbeddedJson,
  parseParserHint,
  parseTs,
  pick,
  rangeEndNanos,
  sniffLevel,
  sniffTs,
  stripVolatile,
} from '../src/fields.ts'

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

describe('rangeEndNanos', () => {
  const nanosOf = (text: string): bigint => {
    const ts = parseTs(text)
    assert.ok(ts !== null)
    return ts.nanos
  }

  it('날짜만 주면 그날 전체를 포함한다 (배타적 상한 = 다음날 자정)', () => {
    // --to 2026-09-04 가 자정 한 순간이 되면 사실상 아무것도 안 잡힌다.
    assert.equal(rangeEndNanos('2026-09-04'), nanosOf('2026-09-05T00:00:00Z'))
  })

  it('분/초 정밀도는 그 눈금 하나만큼 늘어난다', () => {
    assert.equal(rangeEndNanos('2026-09-04T02:19'), nanosOf('2026-09-04T02:20:00Z'))
    assert.equal(rangeEndNanos('2026-09-04T02:19:24'), nanosOf('2026-09-04T02:19:25Z'))
  })

  it('소수 초는 준 자릿수의 한 눈금이다', () => {
    assert.equal(rangeEndNanos('2026-09-04T02:19:24.5'), nanosOf('2026-09-04T02:19:24.6Z'))
    assert.equal(
      rangeEndNanos('2026-09-04T02:19:24.568353422'),
      nanosOf('2026-09-04T02:19:24.568353422Z') + 1n,
    )
  })

  it('수집기가 걸러낸 24.568 줄이 to=…24 범위에 남는 것과 같은 판정이다', () => {
    // 원격 awk 는 프리픽스 비교로 24초 구간 전체를 포함한다. 여기서 상한을
    // 24.000 으로 두면 원격과 로컬 판정이 어긋나 줄이 조용히 사라진다.
    const end = rangeEndNanos('2026-09-04T02:19:24')
    assert.ok(end !== null)
    assert.ok(nanosOf('2026-09-04T02:19:24.568353422Z') < end)
    assert.ok(nanosOf('2026-09-04T02:19:25.000000000Z') >= end)
  })

  it('못 읽는 값은 null', () => {
    assert.equal(rangeEndNanos('not a time'), null)
    assert.equal(rangeEndNanos(''), null)
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

describe('parseParserHint', () => {
  it('객체가 아니면 undefined', () => {
    assert.equal(parseParserHint(undefined), undefined)
    assert.equal(parseParserHint('tsKeys'), undefined)
    assert.equal(parseParserHint(['tsKeys']), undefined)
    assert.equal(parseParserHint(null), undefined)
  })

  it('문자열이 아닌 항목과 빈 문자열은 조용히 버린다', () => {
    // 수집기는 해석 없이 흘리므로 형태 보장이 없다 — 죽는 대신 거른다.
    const hint = parseParserHint({ tsKeys: ['event_time', 3, '', '  '], msgKeys: 'oops' })
    assert.deepEqual(hint, { tsKeys: ['event_time'] })
  })

  it('쓸 만한 키가 하나도 없으면 undefined', () => {
    assert.equal(parseParserHint({ tsKeys: [], msgKeys: [3] }), undefined)
  })
})

describe('mergeAliases', () => {
  it('힌트가 없으면 전역 별칭 그대로', () => {
    assert.equal(mergeAliases(undefined), DEFAULT_ALIASES)
  })

  it('앱 키가 전역 별칭 앞에 온다', () => {
    const merged = mergeAliases({ tsKeys: ['event_time'] })
    assert.equal(merged.ts[0], 'event_time')
    assert.ok(merged.ts.includes('ts'))
  })

  it('앱의 ts·caller 키는 지문 제거 대상에 들어간다', () => {
    const merged = mergeAliases({ tsKeys: ['event_time'], callerKeys: ['origin'] })
    assert.ok(merged.volatile.has('event_time'))
    assert.ok(merged.volatile.has('origin'))
    assert.ok(merged.volatile.has('ts')) // 전역 것도 유지
  })
})

describe('sniffTs', () => {
  it('슬래시 날짜를 읽는다 (lal 계열 비 JSON 줄)', () => {
    // 이걸 못 읽으면 ts 가 null 이라 그 줄이 전부 맨 뒤로 몰리고
    // --from/--to 도 안 먹는다 (시각 없는 줄은 통과가 규약이므로).
    const ts = sniffTs(
      '2026/09/28 07:02:04.648765  INFO [RTMPPUSH246] < R Handshake S0+S1. - client_session.go:333',
    )
    assert.equal(ts?.date.toISOString(), '2026-09-28T07:02:04.648Z')
    assert.equal(ts?.nanos % 1_000_000n, 765_000n, '마이크로초가 보존되지 않았다')
  })

  it('하이픈 날짜도 그대로 읽는다', () => {
    assert.equal(
      sniffTs('2026-09-28 07:02:04.648765  INFO plain')?.date.toISOString(),
      '2026-09-28T07:02:04.648Z',
    )
  })

  it('시각처럼 보이는 게 없으면 null 이다', () => {
    assert.equal(sniffTs('panic: runtime error: invalid memory address'), null)
  })
})

describe('sniffLevel', () => {
  it('plain 줄의 레벨을 잡는다', () => {
    assert.equal(
      sniffLevel('2026/09/28 07:02:05.100000  ERROR [RTMPPUSH246] connect failed'),
      'ERROR',
    )
    assert.equal(sniffLevel('2026/09/28 07:02:04.648765  INFO [RTMPPUSH246] < R'), 'INFO')
  })

  it('소문자는 안 잡는다 — 메시지 본문의 단어와 구분할 수 없다', () => {
    assert.equal(sniffLevel('2026/09/28 07:02:05  retrying after error response'), '')
  })

  it('레벨은 앞쪽에 오므로 첫 매치를 쓴다', () => {
    assert.equal(sniffLevel('07:02:05 INFO handler returned ERROR to client'), 'INFO')
  })

  it('Go 의 panic 은 소문자로 줄 맨 앞에 온다', () => {
    assert.equal(sniffLevel('panic: runtime error: invalid memory address'), 'PANIC')
  })

  it('WARNING 을 WARN 으로 자르지 않는다 (색 표에 둘 다 있다)', () => {
    assert.equal(sniffLevel('2026/09/28 07:02:05  WARNING disk almost full'), 'WARNING')
  })
})
