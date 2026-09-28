/**
 * /api 호출과 응답 타입. 필드 이름은 파서의 NDJSON 계약(camelCase)을 그대로
 * 따른다 — 서버가 renderJsonl 출력을 변형 없이 실어 보내기 때문이다.
 */

/** meta.json 내용 (cli.ts RunInfo 와 같은 모양) */
export interface RunMeta {
  app: string
  env: string
  fields: Record<string, string>
  opts: string[]
}

export interface RunSummary {
  id: string
  mtime: string
  meta: RunMeta | null
}

/** renderJsonl 한 줄 — parser/src/render.ts 의 직렬화 결과 */
export interface ViewRecord {
  ts: string | null
  tsNanos: string | null
  tsInherited: boolean
  tsKey: string
  area: string
  host: string
  source: string
  file: string
  seq: number
  level: string
  msg: string
  caller: string
  match: { kind: string; path?: string }
  repeat: number
  repeatUntil: string | null
  isJson: boolean
  raw: string
  fields: Record<string, unknown>
}

export interface HostResult {
  area: string
  host: string
  status: string
  lineCount: number
  truncated: boolean
  error?: string
  elapsedMs: number
}

export interface RunDetail {
  app: string
  environment: string
  criteria: { field: string; value: string }[]
  viewHint?: { default?: string; lane?: string; session?: string }
  areaOrder: string[]
  hosts: HostResult[]
  records: ViewRecord[]
  malformed: number
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export interface RunsResponse {
  /** run 이 쌓이는 실제 폴더 — XDG 상태 디렉토리 (레포 안 .runs 아님) */
  root: string
  runs: RunSummary[]
}

export function getRuns(): Promise<RunsResponse> {
  return getJson('/api/runs')
}

export function getRun(id: string, collapse: boolean): Promise<RunDetail> {
  return getJson(`/api/runs/${encodeURIComponent(id)}?collapse=${collapse ? 1 : 0}`)
}

export function getApps(): Promise<{ path: string; text: string | null }> {
  return getJson('/api/apps')
}

export async function putApps(text: string): Promise<void> {
  const res = await fetch('/api/apps', { method: 'PUT', body: text })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
}
