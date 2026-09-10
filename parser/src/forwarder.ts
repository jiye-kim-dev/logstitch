/**
 * forwarder(live-stream-forwarder) 로그의 의미론 해석.
 *
 * 이 앱은 두 노드가 같은 스트림(cpk:channelKey)을 두고 경쟁하는 이중화
 * 구조라서, 로그의 관심사가 "누가 선점했고 누가 대기했는가"다. 여기서는
 * 한 줄을 경쟁 뷰(contention)의 의미 이벤트로 분류한다.
 *
 * action / fsm_reason 카탈로그의 근거는
 * docs/20260909-stream-timeline-report-design.md 2.4 / 3.4 장이다.
 * 정의에 없는 값이 와도 죽지 않고 info 로 흘려보낸다 — 원본 모듈에
 * action 이 추가될 때마다 파서가 깨지면 안 된다.
 */

import type { Classified, EventKind } from './profiles.ts'
import type { LogRecord } from './types.ts'

/** fsm_reason → 이벤트 종류. 전이 방향만으로는 정상 종료와 강등을 못 가른다. */
const REASON_KIND: Record<string, EventKind> = {
  initial_activate: 'acquire',
  peer_expired: 'contend',
  wowza_connect_success: 'acquire',
  switch_failed: 'demote',
  reconnect_failed: 'demote',
  forwarding_fail: 'contend',
  stream_closed_while_connecting: 'close',
  graceful_shutdown: 'close',
}

const REASON_LABELS: Record<string, string> = {
  initial_activate: '최초 진입, 즉시 Active 확보',
  peer_expired: '상대 만료 감지 — 경쟁 승리, 승격 시도',
  wowza_connect_success: 'Wowza 연결 성공 — Active 확보',
  switch_failed: '승격 실패 (Wowza 연결 실패) → Standby',
  reconnect_failed: '재연결 실패 / 소유권 상실 → Standby',
  forwarding_fail: '포워딩 이상 — 재연결 시도',
  stream_closed_while_connecting: '연결 중 스트림 종료',
  graceful_shutdown: '정상 종료',
}

/** FSM 전이 없이 세션이 끝나는 축출 이벤트들 (설계 문서 3.5 장 요점). */
const KICK_LABELS: Record<string, string> = {
  different_stream_kick: '다른 stream_key 가 방송 중 → kick',
  same_domain_dup_kick: '같은 도메인 중복 인입 → kick',
  publish_rejected: '인입 거절 (max publisher 초과 등)',
  hook_duplicated: 'hook 중복 차단',
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

/** server_id / 도메인 / URL 에 박힌 인스턴스 토큰. `stage-forwarder-a-kr` → a. */
const LANE_TOKEN = /forwarder-([a-z0-9]+)/i

function laneToken(s: string): string | null {
  const m = LANE_TOKEN.exec(s)
  return m ? `forwarder-${m[1]!.toLowerCase()}` : null
}

function infoObject(record: LogRecord): Record<string, unknown> {
  const info = record.fields['info']
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? (info as Record<string, unknown>)
    : {}
}

/**
 * forwarder 로그의 레인(경쟁 인스턴스 a/b)을 정한다.
 *
 * 인스턴스 정체는 토폴로지(호스트·파일 위치)가 아니라 로그 payload 에 있다.
 * dev 는 한 호스트에 컨테이너 둘, stage/prod 는 호스트 둘에 하나씩이라
 * 위치로는 못 가른다. 그래서 순서대로:
 *
 *   1. server_id (top-level 또는 info 안). 값이 있으면 쓰되
 *      "stage-forwarder-a-kr" 같은 변형은 "forwarder-a" 로 정규화해
 *      환경마다 문자열이 달라도 레인이 갈리지 않게 한다.
 *   2. 세션 컨텍스트 전 로그(OnPubStart)는 server_id 가 비어 있다 —
 *      이때는 domain / url 에 박힌 a/b 토큰을 쓴다.
 *   3. 그래도 못 정하면 null — 뷰의 범용 폴백(lane 필드 → source/host)에
 *      맡긴다. 여기서 host 로 단정하면 dev(한 호스트에 인스턴스 둘)의
 *      source 폴백이 무력화된다.
 */
export function forwarderLane(record: LogRecord): string | null {
  const info = infoObject(record)
  const candidates = [
    text(record.fields['server_id']),
    text(info['server_id']),
    text(record.fields['domain']),
    text(info['domain']),
    text(record.fields['url']),
    text(info['url']),
  ]
  for (const candidate of candidates) {
    if (candidate === '') continue
    const token = laneToken(candidate)
    if (token !== null) return token
  }
  // forwarder- 토큰이 어디에도 없지만 server_id 원값이 있으면 그대로 쓴다.
  const raw = text(record.fields['server_id']) || text(info['server_id'])
  return raw !== '' ? raw : null
}

/** forwarder 로그 한 줄을 경쟁 뷰의 의미 이벤트로 분류한다. */
export function classifyForwarder(record: LogRecord): Classified {
  const f = record.fields
  const action = text(f['action'])

  if (action === 'fsm_transition') {
    const from = text(f['fsm_before'])
    const to = text(f['fsm_after'])
    const reason = text(f['fsm_reason'])
    const kind =
      REASON_KIND[reason] ?? (to.toLowerCase() === 'active' ? 'acquire' : 'demote')
    const label =
      REASON_LABELS[reason] ?? `${from} → ${to}${reason !== '' ? ` (${reason})` : ''}`
    return { kind, label, transition: { from, to, reason } }
  }

  if (Object.hasOwn(KICK_LABELS, action)) {
    return { kind: 'kick', label: KICK_LABELS[action]! }
  }

  switch (action) {
    case 'forward-account-check': {
      const outcome = text(f['outcome'])
      if (outcome === 'failure' || text(f['reason']) === 'forwarding_disabled') {
        return { kind: 'kick', label: '계정 확인 실패 → kick' }
      }
      return { kind: 'info', label: '계정 확인 통과' }
    }
    case 'different_stream_takeover':
      return { kind: 'contend', label: '기존 방송 heartbeat 사망 → active 승계 시도' }
    case 'pub_start':
      return { kind: 'start', label: '스트림 인입 (pub_start)' }
    case 'pub_stop':
      return { kind: 'close', label: '스트림 종료 (pub_stop)' }
    // Standby 에서의 정상 종료는 fsm_transition 없이 이 action 만 남는다.
    case 'stream_closed':
      return { kind: 'close', label: 'Standby 정상 종료' }
    case 'heartbeat_fail':
      return { kind: 'fail', label: 'heartbeat 갱신 실패' }
    case 'idle_timeout':
      return { kind: 'fail', label: '유휴 감지 (비정상 네트워크 종료 의심)' }
    case 'session_re_entry':
      return { kind: 'info', label: '같은 서버 재진입 감지' }
    case 'wowza_connect': {
      const outcome = text(f['outcome'])
      if (outcome === 'success') return { kind: 'info', label: 'Wowza 연결 성공' }
      if (outcome === 'aborted') return { kind: 'fail', label: 'Wowza 연결 중단' }
      return { kind: 'fail', label: 'Wowza 연결 실패' }
    }
    default:
      break
  }

  if (text(f['reason']) === 'lost_ownership') {
    return { kind: 'fail', label: '소유권 상실 (lost_ownership)' }
  }

  const fallback = record.msg !== '' ? record.msg : action !== '' ? action : record.raw
  return { kind: 'info', label: fallback }
}
