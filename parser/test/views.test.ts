import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseTs } from '../src/fields.ts'
import { classifyForwarder, forwarderLane } from '../src/forwarder.ts'
import {
  PROFILES,
  classifyGeneric,
  contentionSetup,
  parseViewHint,
  resolveView,
} from '../src/profiles.ts'
import type { LogRecord } from '../src/types.ts'
import { SKEW_SUSPECT_NANOS, buildContentionModel, fmtDelta } from '../src/view-contention.ts'
import { buildFlowModel } from '../src/view-flow.ts'

interface RecOptions {
  time?: string
  area?: string
  host?: string
  fields?: Record<string, unknown>
  msg?: string
  level?: string
}

function rec(opt: RecOptions = {}): LogRecord {
  const ts = opt.time !== undefined ? parseTs(opt.time) : null
  return {
    app: 'test',
    environment: 'dev',
    area: opt.area ?? 'main',
    host: opt.host ?? 'node-a',
    source: 'app',
    file: 'app.log',
    seq: 0,
    raw: '',
    isJson: true,
    fields: opt.fields ?? {},
    ts,
    tsInherited: false,
    tsKey: ts !== null ? 'time' : null,
    level: opt.level ?? 'INFO',
    msg: opt.msg ?? '',
    caller: '',
    usedKeys: [],
    match: { kind: 'field' },
    sig: null,
  }
}

/** forwarder 전이 로그 축약 생성기. */
function transition(
  time: string,
  server: string,
  from: string,
  to: string,
  reason: string,
): LogRecord {
  return rec({
    time,
    host: server,
    fields: {
      action: 'fsm_transition',
      server_id: server,
      fsm_before: from,
      fsm_after: to,
      fsm_reason: reason,
    },
  })
}

describe('resolveView', () => {
  const profile = PROFILES['forwarder']!

  it('--view 플래그가 최우선이다', () => {
    assert.equal(resolveView('flow', { default: 'contention' }, profile), 'flow')
  })

  it('플래그가 없으면 apps.json 힌트를 따른다', () => {
    assert.equal(resolveView(undefined, { default: 'timeline' }, profile), 'timeline')
  })

  it('힌트도 없으면 앱 프로필 기본값', () => {
    assert.equal(resolveView(undefined, undefined, profile), 'contention')
  })

  it('아무것도 없으면 timeline — 기존 출력이 그대로 나온다', () => {
    assert.equal(resolveView(undefined, undefined, undefined), 'timeline')
  })

  it('힌트의 모르는 뷰 이름은 무시하고 다음 순위로 내려간다', () => {
    assert.equal(resolveView(undefined, { default: '3d-hologram' }, profile), 'contention')
  })
})

describe('parseViewHint', () => {
  it('객체가 아니면 undefined', () => {
    assert.equal(parseViewHint('contention'), undefined)
    assert.equal(parseViewHint(null), undefined)
    assert.equal(parseViewHint([1]), undefined)
  })

  it('문자열 값만 받고 나머지는 조용히 버린다', () => {
    const hint = parseViewHint({ default: 'flow', lane: 42, session: '' })
    assert.equal(hint?.default, 'flow')
    assert.equal(hint?.lane, undefined)
    assert.equal(hint?.session, undefined)
  })
})

describe('contentionSetup', () => {
  it('힌트가 프로필보다 우선한다 — 설정은 재컴파일 없이 바뀌어야 하므로', () => {
    const setup = contentionSetup({ lane: 'node_name' }, PROFILES['forwarder'])
    assert.equal(setup.lane, 'node_name')
    assert.equal(setup.session, 'trace_id') // 힌트에 없으면 프로필 값
    assert.equal(setup.laneFallback, 'source') // forwarder 프로필 값
    assert.equal(setup.classify, classifyForwarder)
  })

  it('의미론 함수는 프로필 전용이다 — 힌트로는 함수를 표현할 수 없으므로', () => {
    const setup = contentionSetup({ lane: 'node_name' }, PROFILES['forwarder'])
    assert.equal(setup.resolveLane, forwarderLane)
  })

  it('프로필이 없으면 범용 분류와 host 폴백을 쓴다', () => {
    const setup = contentionSetup(undefined, undefined)
    assert.equal(setup.lane, null)
    assert.equal(setup.laneFallback, 'host')
    assert.equal(setup.resolveLane, null)
    assert.equal(setup.classify, classifyGeneric)
  })

  it('힌트의 laneFallback 이 이상한 값이면 버리고 프로필로 내려간다', () => {
    const setup = contentionSetup({ laneFallback: 'moon' }, PROFILES['forwarder'])
    assert.equal(setup.laneFallback, 'source')
  })
})

describe('buildFlowModel', () => {
  it('영역별 블록과 핸드오프 갭을 계산한다', () => {
    const records = [
      rec({ area: 'ingest', time: '2026-09-09T10:00:00Z' }),
      rec({ area: 'ingest', time: '2026-09-09T10:00:01Z' }),
      rec({ area: 'worker', time: '2026-09-09T10:00:03Z' }),
      rec({ area: 'worker', time: '2026-09-09T10:00:05Z' }),
    ]
    const model = buildFlowModel(records, ['ingest', 'worker'])

    assert.deepEqual(model.groups.map((g) => g.area), ['ingest', 'worker'])
    assert.equal(model.groups[0]!.records.length, 2)
    assert.equal(model.gaps.length, 1)
    assert.equal(model.gaps[0], 2) // 10:00:01 → 10:00:03
  })

  it('시간이 겹치면 음수 갭 — 병렬 처리나 clock skew 의 신호다', () => {
    const records = [
      rec({ area: 'a', time: '2026-09-09T10:00:00Z' }),
      rec({ area: 'a', time: '2026-09-09T10:00:10Z' }),
      rec({ area: 'b', time: '2026-09-09T10:00:05Z' }),
    ]
    const model = buildFlowModel(records, ['a', 'b'])
    assert.equal(model.gaps[0], -5)
  })

  it('레코드가 없는 영역은 블록을 만들지 않는다', () => {
    const model = buildFlowModel(
      [rec({ area: 'b', time: '2026-09-09T10:00:00Z' })],
      ['a', 'b', 'c'],
    )
    assert.deepEqual(model.groups.map((g) => g.area), ['b'])
    assert.equal(model.gaps.length, 0)
  })

  it('areaOrder 에 없는 영역도 버리지 않고 뒤에 붙인다', () => {
    const model = buildFlowModel(
      [
        rec({ area: 'known', time: '2026-09-09T10:00:00Z' }),
        rec({ area: 'surprise', time: '2026-09-09T10:00:01Z' }),
      ],
      ['known'],
    )
    assert.deepEqual(model.groups.map((g) => g.area), ['known', 'surprise'])
  })
})

describe('buildContentionModel', () => {
  const forwarderSetup = contentionSetup(undefined, PROFILES['forwarder'])

  it('레인은 lane 필드에서 나오고, forwarder 는 없으면 source 로 폴백한다', () => {
    // 한 호스트(dv01lo02)가 forwarder-a/b 인스턴스를 둘 다 돌리는 배치에서,
    // OnPubStart 처럼 server_id 가 비어 있는 줄은 로그 파일(source)이 곧
    // 인스턴스다. host 폴백이면 두 인스턴스가 한 레인에 섞인다.
    const withSource = (source: string, over: Parameters<typeof rec>[0]): LogRecord => ({
      ...rec(over),
      source,
    })
    const model = buildContentionModel(
      [
        withSource('forwarder-a', {
          time: '2026-09-09T10:00:00Z', host: 'dv01lo02',
          fields: { server_id: 'forwarder-a' },
        }),
        // server_id 가 빈 문자열 — 실제 OnPubStart 로그가 이렇다.
        withSource('forwarder-b', {
          time: '2026-09-09T10:00:01Z', host: 'dv01lo02',
          fields: { server_id: '' },
        }),
      ],
      forwarderSetup,
    )
    assert.deepEqual(model.laneOrder, ['forwarder-a', 'forwarder-b'])
  })

  it('stage 배치: 호스트가 달라도 소스명이 같으면 domain 토큰으로 레인을 가른다', () => {
    // stage/prod 는 물리 노드 2대가 같은 앱 이름(=같은 소스명)으로 뜬다.
    // top-level server_id 는 없고 domain 만 다르므로, 커스텀 해석 없이는
    // source 폴백이 두 노드를 한 레인으로 합쳐 버린다.
    const stageRec = (time: string, host: string, domain: string): LogRecord => ({
      ...rec({
        time, host,
        fields: { action: 'pub_start', trace_id: `t-${host}`, domain },
      }),
      source: 'forwarder', // 두 노드 모두 같은 소스명
    })
    const model = buildContentionModel(
      [
        stageRec('2026-09-10T00:28:25.088Z', 'st01', 'forwarder-a-stage-kr.kollus.com'),
        stageRec('2026-09-10T00:28:25.150Z', 'st02', 'forwarder-b-stage-kr.kollus.com'),
      ],
      forwarderSetup,
    )
    assert.deepEqual(model.laneOrder, ['forwarder-a', 'forwarder-b'])
  })

  it('stage 배치: info 안에 중첩된 OnPubStart 줄도 url 토큰으로 제 레인에 합류한다', () => {
    const onPubStart: LogRecord = rec({
      time: '2026-09-10T00:28:25.088Z',
      host: 'st01',
      fields: {
        info: {
          server_id: '',
          url: 'rtmp://forwarder-a-stage-kr.kollus.com:1935/as1as/gfkzuhdk9tu5n3gx/al6kgzii',
        },
      },
    })
    const lifecycle: LogRecord = rec({
      time: '2026-09-10T00:28:25.089Z',
      host: 'st01',
      fields: { action: 'pub_start', domain: 'forwarder-a-stage-kr.kollus.com' },
    })
    const model = buildContentionModel([onPubStart, lifecycle], forwarderSetup)
    assert.deepEqual(model.laneOrder, ['forwarder-a'])
  })

  it('레인 근거가 없는 줄(heartbeat 등)은 세션(trace_id) 매핑으로 제 레인에 귀속된다', () => {
    // stage 의 내부 로직 줄은 server_id/domain/url 이 전부 없지만 trace_id 는
    // 찍힌다. lifecycle 줄이 trace_id → forwarder-a 를 확정해 두었으므로
    // source 폴백('forwarder')으로 새지 않고 같은 레인에 합류해야 한다.
    const withSource = (over: Parameters<typeof rec>[0]): LogRecord => ({
      ...rec(over),
      source: 'forwarder',
    })
    const model = buildContentionModel(
      [
        withSource({
          time: '2026-09-10T00:28:25.089Z', host: 'st01',
          fields: { action: 'pub_start', trace_id: 't-a', domain: 'forwarder-a-stage-kr.kollus.com' },
        }),
        withSource({
          time: '2026-09-10T00:29:00.000Z', host: 'st01',
          fields: { action: 'heartbeat_fail', trace_id: 't-a' },
        }),
      ],
      forwarderSetup,
    )
    assert.deepEqual(model.laneOrder, ['forwarder-a'])
    assert.equal(model.events[1]!.lane, 'forwarder-a')
  })

  it('귀속될 줄이 매핑을 세우는 줄보다 먼저 와도 귀속된다 — 그래서 2패스다', () => {
    const model = buildContentionModel(
      [
        rec({
          time: '2026-09-10T00:28:25.000Z', host: 'st01',
          fields: { action: 'heartbeat_fail', trace_id: 't-a' },
        }),
        rec({
          time: '2026-09-10T00:28:25.089Z', host: 'st01',
          fields: { action: 'pub_start', trace_id: 't-a', domain: 'forwarder-a-stage-kr.kollus.com' },
        }),
      ],
      forwarderSetup,
    )
    assert.deepEqual(model.laneOrder, ['forwarder-a'])
  })

  it('어느 줄도 확정해 주지 않은 세션 값은 기존 폴백(source/host)으로 내려간다', () => {
    const model = buildContentionModel(
      [
        rec({
          time: '2026-09-10T00:29:00.000Z', host: 'st01',
          fields: { action: 'heartbeat_fail', trace_id: 't-unknown' },
        }),
      ],
      forwarderSetup,
    )
    assert.deepEqual(model.laneOrder, ['app']) // rec 기본 source
  })

  it('같은 세션 값이 두 레인에서 확정되면 노드를 넘나드는 id 로 보고 귀속에 쓰지 않는다', () => {
    // flow 계열의 rid 처럼 세션 값이 노드 간에 공유되는 앱에서, 근거 없는
    // 줄이 먼저 확정한 레인에 접착되어 버리면 안 된다 — 폴백이 안전하다.
    const model = buildContentionModel(
      [
        rec({
          time: '2026-09-10T00:28:25.000Z', host: 'st01',
          fields: { action: 'pub_start', trace_id: 'shared', domain: 'forwarder-a-stage-kr.kollus.com' },
        }),
        rec({
          time: '2026-09-10T00:28:25.100Z', host: 'st02',
          fields: { action: 'pub_start', trace_id: 'shared', domain: 'forwarder-b-stage-kr.kollus.com' },
        }),
        rec({
          time: '2026-09-10T00:29:00.000Z', host: 'st03',
          fields: { action: 'heartbeat_fail', trace_id: 'shared' },
        }),
      ],
      forwarderSetup,
    )
    assert.equal(model.events[2]!.lane, 'app') // rec 기본 source 로 폴백
  })

  it('기본 폴백은 host — 호스트마다 같은 소스명을 쓰는 배치가 안전 기준이다', () => {
    const model = buildContentionModel(
      [
        rec({ time: '2026-09-09T10:00:00Z', host: 'h1', fields: {} }),
        rec({ time: '2026-09-09T10:00:01Z', host: 'h2', fields: {} }),
      ],
      contentionSetup({ lane: 'server_id' }, undefined),
    )
    assert.deepEqual(model.laneOrder, ['h1', 'h2'])
  })

  it('Δ 는 직전 이벤트와의 간격이고 첫 이벤트는 null', () => {
    const model = buildContentionModel(
      [
        rec({ time: '2026-09-09T10:00:00Z', fields: { server_id: 'a' } }),
        rec({ time: '2026-09-09T10:00:00.250Z', fields: { server_id: 'a' } }),
      ],
      forwarderSetup,
    )
    assert.equal(model.events[0]!.deltaNanos, null)
    assert.equal(model.events[1]!.deltaNanos, 250_000_000n)
  })

  it('레인이 다르고 간격이 5ms 미만이면 skew 의심 — 같은 레인은 아니다', () => {
    const model = buildContentionModel(
      [
        rec({ time: '2026-09-09T10:00:00.000Z', fields: { server_id: 'a' } }),
        rec({ time: '2026-09-09T10:00:00.002Z', fields: { server_id: 'b' } }),
        rec({ time: '2026-09-09T10:00:00.003Z', fields: { server_id: 'b' } }),
      ],
      forwarderSetup,
    )
    assert.equal(model.events[1]!.skewSuspect, true) // a → b, 2ms
    assert.equal(model.events[2]!.skewSuspect, false) // b → b, 같은 레인
  })

  it('서로 다른 레인의 Active 구간이 겹치면 split-brain 의심으로 잡는다', () => {
    const model = buildContentionModel(
      [
        transition('2026-09-09T10:00:01Z', 'a', 'standby', 'active', 'initial_activate'),
        transition('2026-09-09T10:00:02Z', 'b', 'connecting', 'active', 'wowza_connect_success'),
        transition('2026-09-09T10:00:03Z', 'a', 'active', 'standby', 'reconnect_failed'),
        transition('2026-09-09T10:00:04Z', 'b', 'active', 'standby', 'graceful_shutdown'),
      ],
      forwarderSetup,
    )

    assert.equal(model.intervals.length, 2)
    assert.equal(model.overlaps.length, 1)
    const overlap = model.overlaps[0]!
    // 겹침은 b 획득(10:00:02)부터 a 이탈(10:00:03)까지.
    assert.equal(overlap.from.date.toISOString(), '2026-09-09T10:00:02.000Z')
    assert.equal(overlap.to.date.toISOString(), '2026-09-09T10:00:03.000Z')

    assert.equal(model.finalState.get('a'), 'standby (reconnect_failed)')
    assert.equal(model.finalState.get('b'), 'standby (graceful_shutdown)')
  })

  it('정상 교대(겹침 없음)는 split-brain 으로 잡지 않는다', () => {
    const model = buildContentionModel(
      [
        transition('2026-09-09T10:00:01Z', 'a', 'standby', 'active', 'initial_activate'),
        transition('2026-09-09T10:00:03Z', 'a', 'active', 'standby', 'reconnect_failed'),
        transition('2026-09-09T10:00:05Z', 'b', 'connecting', 'active', 'wowza_connect_success'),
        transition('2026-09-09T10:00:09Z', 'b', 'active', 'standby', 'graceful_shutdown'),
      ],
      forwarderSetup,
    )
    assert.equal(model.overlaps.length, 0)
  })

  it('마지막까지 닫히지 않은 Active 구간은 ongoing 으로 남는다', () => {
    const model = buildContentionModel(
      [
        transition('2026-09-09T10:00:01Z', 'a', 'standby', 'active', 'initial_activate'),
        rec({ time: '2026-09-09T10:05:00Z', fields: { server_id: 'a', action: 'redis_keep_alive' } }),
      ],
      forwarderSetup,
    )
    assert.equal(model.intervals.length, 1)
    assert.equal(model.intervals[0]!.ongoing, true)
    assert.equal(model.intervals[0]!.to.date.toISOString(), '2026-09-09T10:05:00.000Z')
  })

  it('세션 필드가 바뀌는 줄에 세션 시작 표시가 붙는다', () => {
    const model = buildContentionModel(
      [
        rec({ time: '2026-09-09T10:00:00Z', fields: { server_id: 'a', trace_id: 't-1' } }),
        rec({ time: '2026-09-09T10:00:01Z', fields: { server_id: 'a', trace_id: 't-1' } }),
        rec({ time: '2026-09-09T10:00:02Z', fields: { server_id: 'a', trace_id: 't-2' } }),
      ],
      forwarderSetup,
    )
    assert.equal(model.events[0]!.sessionStart, 't-1')
    assert.equal(model.events[1]!.sessionStart, null)
    assert.equal(model.events[2]!.sessionStart, 't-2')
  })
})

describe('fmtDelta', () => {
  it('ms 레이스 분석에 맞는 단위를 고른다', () => {
    assert.equal(fmtDelta(412_000n), '+412µs')
    assert.equal(fmtDelta(27_000_000n), '+27ms')
    assert.equal(fmtDelta(1_003_000_000n), '+1.003s')
    assert.equal(fmtDelta(64_000_000_000n), '+1m04s')
  })

  it('skew 임계값은 5ms 다', () => {
    assert.equal(SKEW_SUSPECT_NANOS, 5_000_000n)
  })
})
