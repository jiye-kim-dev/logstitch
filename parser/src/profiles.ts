/**
 * 앱 프로필 — 앱 이름을 "어떤 뷰로, 어떤 의미론으로 보여줄지"에 연결한다.
 *
 * 뷰는 로그의 관계 패턴에서 나오는 범용 개념 2가지다:
 *
 *   flow        하나의 요청이 여러 영역(애플리케이션)을 순차 통과 (ai-stt)
 *   contention  여러 노드가 같은 자원을 두고 동시 경쟁 (forwarder)
 *
 * 앱별로 렌더러를 만들지 않는다. 뷰는 범용이고, 프로필이 매핑(레인 필드,
 * 의미 분류 함수)만 제공한다. 세 번째 앱이 경쟁 패턴이면 apps.json 힌트만으로
 * contention 뷰를 그대로 쓸 수 있고, FSM 같은 의미론이 필요해지면 여기에
 * classify 함수 하나를 추가한다.
 *
 * 선택 우선순위: --view 플래그 > apps.json 힌트(meta.view) > 프로필 기본값
 * > timeline(기존 병합 타임라인). 힌트와 프로필이 둘 다 있으면 힌트가
 * 이긴다 — 설정 파일은 재컴파일 없이 바꿀 수 있어야 하므로.
 */

import { classifyForwarder, forwarderLane } from './forwarder.ts'
import type { LogRecord, ViewHint } from './types.ts'

export const VIEW_NAMES = ['timeline', 'flow', 'contention'] as const
export type ViewName = (typeof VIEW_NAMES)[number]

export function isViewName(value: string): value is ViewName {
  return (VIEW_NAMES as readonly string[]).includes(value)
}

/**
 * 레코드 한 줄의 의미 분류. contention 뷰가 심볼·색·상태 재구성에 쓴다.
 *
 * - start    세션 시작
 * - acquire  자원 획득 (Active 확보)
 * - contend  획득 시도 (승격, 재연결, 승계)
 * - demote   대기로 밀림 (Standby 강등)
 * - fail     이상 신호 (heartbeat 실패 등 — 상태는 아직 안 바뀜)
 * - kick     경쟁에서 축출되어 세션 종료
 * - close    정상 종료
 * - info     그 외
 */
export type EventKind =
  | 'start'
  | 'acquire'
  | 'contend'
  | 'demote'
  | 'fail'
  | 'kick'
  | 'close'
  | 'info'

export interface Classified {
  kind: EventKind
  /** 한 줄 설명. 렌더러가 그대로 찍는다. */
  label: string
  /** FSM 전이가 있는 줄만. 상태 구간(Active 겹침 감지) 재구성의 근거. */
  transition?: { from: string; to: string; reason: string }
}

/** 레인 필드가 없는 줄을 어디로 귀속시킬지. types.ts 의 ViewHint 주석 참고. */
export type LaneFallback = 'host' | 'source'

export interface AppProfile {
  defaultView: ViewName
  /** contention 뷰의 레인 필드. apps.json 힌트가 있으면 힌트가 우선. */
  lane?: string
  /** 세션 구분 필드. */
  session?: string
  /** 레인 폴백. 생략하면 'host'. */
  laneFallback?: LaneFallback
  /**
   * 레인 커스텀 해석. classify 처럼 앱 의미론이라 프로필 전용이다 —
   * JSON 힌트로는 "server_id 를 정규화하고 domain 토큰으로 폴백" 같은
   * 로직을 표현할 수 없으므로, 선언적 lane 필드보다 먼저 본다.
   * null 을 반환하면 lane 필드 → laneFallback 의 범용 경로로 내려간다.
   */
  resolveLane?: (record: LogRecord) => string | null
  /** 앱 의미론 분류. 없으면 범용 분류(레벨 기반)를 쓴다. */
  classify?: (record: LogRecord) => Classified
}

export const PROFILES: Record<string, AppProfile> = {
  'ai-stt': { defaultView: 'flow' },
  forwarder: {
    defaultView: 'contention',
    lane: 'server_id',
    session: 'trace_id',
    // dev 는 한 호스트가 forwarder-a/b 인스턴스를 둘 다 돌리고, 인벤토리
    // 소스명이 server_id 값과 같다. 세션 컨텍스트 전 로그(OnPubStart 등)는
    // server_id 가 비어 있으므로 host 폴백이면 두 인스턴스가 한 레인에 섞인다.
    laneFallback: 'source',
    // stage/prod 는 server_id 가 top-level 이 아니라 info 안에 있거나 아예
    // 없는 줄이 많다(stream lifecycle 은 domain 만 찍힘). 필드명 하나로는
    // 못 가르므로 payload 전체(server_id 정규화 → domain/url 토큰)를 보는
    // 커스텀 해석을 먼저 태운다. server_id/domain/url 이 전부 없는 내부
    // 줄(heartbeat 등)은 contention 뷰가 세션(trace_id) → 레인 매핑으로
    // 귀속한다 — trace_id 는 노드가 세션마다 만들므로 레인에 유일하다.
    resolveLane: forwarderLane,
    classify: classifyForwarder,
  },
}

/**
 * 의미론 프로필이 없는 앱을 위한 범용 분류.
 * ERROR 급만 fail 로 띄우고 나머지는 흘려보낸다 — 틀린 추측보다 무해하다.
 */
export function classifyGeneric(record: LogRecord): Classified {
  const label = record.msg !== '' ? record.msg : record.raw
  if (record.level === 'ERROR' || record.level === 'FATAL' || record.level === 'PANIC') {
    return { kind: 'fail', label }
  }
  return { kind: 'info', label }
}

/**
 * meta.view 로 들어온 값을 검증한다. 수집기는 내용을 해석하지 않고 흘리므로
 * 형태 보장이 없다 — 문자열이 아닌 값은 조용히 버린다.
 */
export function parseViewHint(raw: unknown): ViewHint | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const pickString = (key: string): string | undefined =>
    typeof obj[key] === 'string' && obj[key] !== '' ? (obj[key] as string) : undefined
  const fallback = pickString('laneFallback')
  return {
    default: pickString('default'),
    lane: pickString('lane'),
    session: pickString('session'),
    laneFallback: fallback === 'host' || fallback === 'source' ? fallback : undefined,
  }
}

/** 뷰 선택: --view 플래그 > apps.json 힌트 > 프로필 기본값 > timeline. */
export function resolveView(
  flag: ViewName | undefined,
  hint: ViewHint | undefined,
  profile: AppProfile | undefined,
): ViewName {
  if (flag !== undefined) return flag
  if (hint?.default !== undefined && isViewName(hint.default)) return hint.default
  return profile?.defaultView ?? 'timeline'
}

/**
 * contention 뷰 설정: 레인/세션 필드와 분류 함수를 힌트·프로필에서 합성한다.
 * 선언적 값(lane/session/laneFallback)은 힌트가 이기지만, 의미론 함수
 * (resolveLane/classify)는 힌트로 표현할 수 없으므로 프로필 전용이다.
 */
export function contentionSetup(
  hint: ViewHint | undefined,
  profile: AppProfile | undefined,
): {
  lane: string | null
  session: string | null
  laneFallback: LaneFallback
  resolveLane: ((r: LogRecord) => string | null) | null
  classify: (r: LogRecord) => Classified
} {
  // 힌트는 수집기가 해석 없이 흘린 값이라 여기서 한 번 더 좁힌다.
  const hinted = hint?.laneFallback
  const laneFallback: LaneFallback | undefined =
    hinted === 'host' || hinted === 'source' ? hinted : undefined
  return {
    lane: hint?.lane ?? profile?.lane ?? null,
    session: hint?.session ?? profile?.session ?? null,
    laneFallback: laneFallback ?? profile?.laneFallback ?? 'host',
    resolveLane: profile?.resolveLane ?? null,
    classify: profile?.classify ?? classifyGeneric,
  }
}
