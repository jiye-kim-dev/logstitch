import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseTs } from '../src/fields.ts'
import { classifyForwarder, forwarderLane } from '../src/forwarder.ts'
import type { LogRecord } from '../src/types.ts'

interface RecOptions {
  time?: string
  host?: string
  fields?: Record<string, unknown>
  msg?: string
  level?: string
  raw?: string
}

function rec(opt: RecOptions = {}): LogRecord {
  const ts = opt.time !== undefined ? parseTs(opt.time) : null
  return {
    app: 'forwarder',
    environment: 'dev',
    area: 'forwarder',
    host: opt.host ?? 'node-a',
    source: 'app',
    file: 'forwarder.log',
    seq: 0,
    raw: opt.raw ?? '',
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

describe('classifyForwarder', () => {
  it('fsm_transition 은 fsm_reason 으로 종류를 정하고 전이를 보존한다', () => {
    const got = classifyForwarder(
      rec({
        fields: {
          action: 'fsm_transition',
          fsm_before: 'standby',
          fsm_after: 'active',
          fsm_reason: 'initial_activate',
        },
      }),
    )
    assert.equal(got.kind, 'acquire')
    assert.deepEqual(got.transition, {
      from: 'standby',
      to: 'active',
      reason: 'initial_activate',
    })
  })

  it('graceful_shutdown 은 standby 로 가는 전이여도 강등이 아니라 종료다', () => {
    // FSM 값으로는 Standby 를 반환하지만 cleanup 이 세션을 끝낸다
    // (설계 문서 3.3 장). demote 로 분류하면 "밀려났다"로 오독된다.
    const got = classifyForwarder(
      rec({
        fields: {
          action: 'fsm_transition',
          fsm_before: 'active',
          fsm_after: 'standby',
          fsm_reason: 'graceful_shutdown',
        },
      }),
    )
    assert.equal(got.kind, 'close')
  })

  it('reconnect_failed 는 강등이다', () => {
    const got = classifyForwarder(
      rec({
        fields: {
          action: 'fsm_transition',
          fsm_before: 'connecting',
          fsm_after: 'standby',
          fsm_reason: 'reconnect_failed',
        },
      }),
    )
    assert.equal(got.kind, 'demote')
  })

  it('모르는 fsm_reason 이 와도 죽지 않고 전이 방향으로 추정한다', () => {
    const got = classifyForwarder(
      rec({
        fields: {
          action: 'fsm_transition',
          fsm_before: 'standby',
          fsm_after: 'active',
          fsm_reason: 'new_reason_from_future',
        },
      }),
    )
    assert.equal(got.kind, 'acquire')
    assert.ok(got.label.includes('new_reason_from_future'))
  })

  it('kick 계열 action 은 kick 으로 분류된다', () => {
    for (const action of [
      'different_stream_kick',
      'same_domain_dup_kick',
      'publish_rejected',
      'hook_duplicated',
    ]) {
      assert.equal(classifyForwarder(rec({ fields: { action } })).kind, 'kick', action)
    }
  })

  it('forward-account-check 는 outcome 에 따라 갈린다', () => {
    assert.equal(
      classifyForwarder(
        rec({ fields: { action: 'forward-account-check', outcome: 'failure' } }),
      ).kind,
      'kick',
    )
    assert.equal(
      classifyForwarder(
        rec({ fields: { action: 'forward-account-check', outcome: 'success' } }),
      ).kind,
      'info',
    )
  })

  it('라이프사이클 action 매핑', () => {
    assert.equal(classifyForwarder(rec({ fields: { action: 'pub_start' } })).kind, 'start')
    assert.equal(classifyForwarder(rec({ fields: { action: 'pub_stop' } })).kind, 'close')
    assert.equal(
      classifyForwarder(rec({ fields: { action: 'stream_closed' } })).kind,
      'close',
    )
    assert.equal(
      classifyForwarder(rec({ fields: { action: 'heartbeat_fail' } })).kind,
      'fail',
    )
    assert.equal(
      classifyForwarder(rec({ fields: { action: 'different_stream_takeover' } })).kind,
      'contend',
    )
  })

  it('wowza_connect 는 outcome 으로 성패를 가른다', () => {
    assert.equal(
      classifyForwarder(
        rec({ fields: { action: 'wowza_connect', outcome: 'success' } }),
      ).kind,
      'info',
    )
    assert.equal(
      classifyForwarder(
        rec({ fields: { action: 'wowza_connect', outcome: 'failure' } }),
      ).kind,
      'fail',
    )
  })

  it('모르는 action 은 info 로 흘리고 msg 를 라벨로 쓴다', () => {
    const got = classifyForwarder(
      rec({ fields: { action: 'redis_keep_alive' }, msg: 'keep alive ok' }),
    )
    assert.equal(got.kind, 'info')
    assert.equal(got.label, 'keep alive ok')
  })
})

describe('forwarderLane', () => {
  it('server_id 의 환경별 변형을 forwarder-a 로 정규화한다', () => {
    assert.equal(
      forwarderLane(rec({ fields: { server_id: 'stage-forwarder-a-kr' } })),
      'forwarder-a',
    )
    assert.equal(
      forwarderLane(rec({ fields: { server_id: 'forwarder-b' } })),
      'forwarder-b',
    )
  })

  it('OnPubStart 처럼 server_id 가 info 안에 비어 있으면 url 토큰을 쓴다', () => {
    // stage 실로그 형태: 필드가 전부 info 객체 안에 중첩되고 server_id 는 빈 값.
    const got = forwarderLane(
      rec({
        fields: {
          info: {
            server_id: '',
            url: 'rtmp://forwarder-a-stage-kr.kollus.com:1935/as1as/gfkzuhdk9tu5n3gx/al6kgzii',
            app_name: 'as1as/gfkzuhdk9tu5n3gx',
          },
        },
      }),
    )
    assert.equal(got, 'forwarder-a')
  })

  it('stream lifecycle 처럼 server_id 없이 domain 만 있으면 domain 토큰을 쓴다', () => {
    const got = forwarderLane(
      rec({
        fields: {
          action: 'pub_start',
          trace_id: '49baf5df-5ad9-43e8-8a29-961784a6bdb0',
          domain: 'forwarder-b-stage-kr.kollus.com',
        },
      }),
    )
    assert.equal(got, 'forwarder-b')
  })

  it('토큰이 없어도 server_id 원값이 있으면 그대로 쓴다', () => {
    assert.equal(forwarderLane(rec({ fields: { server_id: 'node-x' } })), 'node-x')
  })

  it('아무 근거가 없으면 null — 뷰의 범용 폴백(source/host)에 맡긴다', () => {
    assert.equal(forwarderLane(rec({ fields: { action: 'redis_keep_alive' } })), null)
  })
})
