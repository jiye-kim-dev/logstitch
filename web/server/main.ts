/**
 * logstitch 웹 뷰어 백엔드 (Hono).
 *
 * cli.ts 의 NDJSON 소비 루프를 웹용으로 축약한 것 — 파싱·정렬·접기는 전부
 * parser/src/index.ts 라이브러리를 재사용하고, 여기는 HTTP 와 파일 읽기/쓰기만
 * 안다. ssh·수집은 여전히 수집기 소유다 (뷰어는 .runs 원본만 재렌더한다).
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  FAR_FUTURE_NANOS,
  Normalizer,
  collapseRuns,
  mergeAliases,
  parseParserHint,
  parseViewHint,
  renderJsonl,
} from '../../parser/src/index.ts'
import type {
  CollectorEvent,
  Criterion,
  HostEvent,
  LogRecord,
  ViewHint,
} from '../../parser/src/index.ts'

// ── 경로 규약 ──────────────────────────────────────────────────────────────
// cli.ts 의 runsRoot() / 수집기의 설정 탐색과 같은 XDG 규약. cli.ts 는 CLI
// 전용 파일(스트림·인자 파싱)이라 import 하지 않고 6줄을 복제한다.

function runsRoot(): string {
  const state = process.env['XDG_STATE_HOME']
  const base = state !== undefined && state !== '' ? state : join(homedir(), '.local', 'state')
  return join(base, 'logstitch', 'runs')
}

function appsPath(): string {
  const cfg = process.env['XDG_CONFIG_HOME']
  const base = cfg !== undefined && cfg !== '' ? cfg : join(homedir(), '.config')
  return join(base, 'logstitch', 'apps.json')
}

// run 디렉토리 이름 규약(newRunDir 의 clean)과 같은 문자 집합.
// URL 파라미터가 경로로 들어가므로 ../ 탈출을 여기서 차단한다.
const RUN_ID = /^[A-Za-z0-9._-]+$/

// ── NDJSON → 레코드 ────────────────────────────────────────────────────────

interface RunDetail {
  app: string
  environment: string
  criteria: Criterion[]
  viewHint: ViewHint | undefined
  areaOrder: string[]
  hosts: HostEvent[]
  /** renderJsonl 직렬화 결과 (bigint 없음 — 그대로 JSON 응답에 실린다) */
  records: unknown[]
  malformed: number
}

/** cli.ts 메인 루프의 축약판 — meta → Normalizer 구성, line → 정규화, host → 수집. */
function parseRun(text: string, collapse: boolean): RunDetail {
  const records: LogRecord[] = []
  const hosts: HostEvent[] = []
  const areaOrder: string[] = []
  const seenArea = new Set<string>()
  const pushArea = (area: string): void => {
    if (!seenArea.has(area)) {
      seenArea.add(area)
      areaOrder.push(area)
    }
  }

  let normalizer: Normalizer | null = null
  let app = ''
  let environment = ''
  let criteria: Criterion[] = []
  let viewHint: ViewHint | undefined
  let malformed = 0

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event: CollectorEvent
    try {
      event = JSON.parse(line) as CollectorEvent
    } catch {
      malformed += 1
      continue
    }

    switch (event.type) {
      case 'meta': {
        app = event.app ?? ''
        environment = event.environment ?? ''
        criteria = event.fields ?? []
        viewHint = parseViewHint(event.view)
        const primary = criteria[0] ?? { field: '', value: '' }
        normalizer = new Normalizer({
          app,
          environment,
          field: primary.field,
          value: primary.value,
          aliases: mergeAliases(parseParserHint(event.parser)),
        })
        for (const area of event.areas ?? []) pushArea(area)
        break
      }
      case 'line': {
        if (normalizer === null) {
          throw new Error('meta 이벤트가 먼저 오지 않았습니다 — raw.ndjson 이 맞는지 확인')
        }
        pushArea(event.area)
        records.push(normalizer.push(event))
        break
      }
      case 'host':
        pushArea(event.area)
        hosts.push(event)
        break
    }
  }

  // 정렬은 cli.ts 와 같은 비교자 — 같은 시각이면 원래 스트림 순서(seq) 유지.
  records.sort((a, b) => {
    const an = a.ts?.nanos ?? FAR_FUTURE_NANOS
    const bn = b.ts?.nanos ?? FAR_FUTURE_NANOS
    if (an !== bn) return an < bn ? -1 : 1
    if (a.host !== b.host) return a.host < b.host ? -1 : 1
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.seq - b.seq
  })

  // ponytail: cli.ts 의 --strict / --where / --from·--to 재필터는 생략 —
  // 뷰어는 원본 전체를 보여준다. 필터 UI 가 생기면 그때 같은 판정을 가져온다.
  const kept = collapse ? collapseRuns(records) : records

  const lines: string[] = []
  renderJsonl(kept, (l) => lines.push(l))
  return {
    app,
    environment,
    criteria,
    viewHint,
    areaOrder,
    hosts,
    records: lines.map((l) => JSON.parse(l) as unknown),
    malformed,
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const api = new Hono()

/** run 목록 — meta.json 이 있으면 얹고, 없어도 목록에는 나온다. */
api.get('/runs', async (c) => {
  const root = runsRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return c.json({ root, runs: [] }) // runs 루트가 아직 없음 = 수집 이력 없음
  }
  const runs = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = join(runsRoot(), e.name)
        let meta: unknown = null
        try {
          meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
        } catch {
          /* meta 없는 run 도 목록엔 남긴다 */
        }
        const mtime = (await stat(dir)).mtime.toISOString()
        return { id: e.name, mtime, meta }
      }),
  )
  // 디렉토리 이름이 로컬시각으로 시작하므로 이름 역순 = 최신순
  runs.sort((a, b) => (a.id < b.id ? 1 : -1))
  // root 를 같이 준다 — 화면에 "어느 폴더를 보고 있는지" 보여주기 위해
  // (레포 안 레거시 .runs/ 를 보는 걸로 오해하기 쉽다)
  return c.json({ root, runs })
})

/** run 재렌더 — raw.ndjson 을 라이브러리로 다시 파싱해 구조화된 JSON 으로 준다. */
api.get('/runs/:id', async (c) => {
  const id = c.req.param('id')
  if (!RUN_ID.test(id)) return c.json({ error: '잘못된 run id' }, 400)
  const collapse = c.req.query('collapse') !== '0'

  let text: string
  try {
    text = await readFile(join(runsRoot(), id, 'raw.ndjson'), 'utf8')
  } catch {
    return c.json({ error: 'raw.ndjson 이 없습니다' }, 404)
  }
  try {
    return c.json(parseRun(text, collapse))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422)
  }
})

/** apps.json 읽기 — 파일이 없으면 text: null (편집기가 "저장하면 생성" 안내). */
api.get('/apps', async (c) => {
  const path = appsPath()
  try {
    return c.json({ path, text: await readFile(path, 'utf8') })
  } catch {
    return c.json({ path, text: null })
  }
})

/** apps.json 저장 — 최소 검증(JSON + apps 객체)만 하고 그대로 쓴다. */
// ponytail: schemas/apps.schema.json 검증은 생략 (ajv 의존성) — 편집기 쪽에서
// $schema 로 IDE 급 검증이 필요해지면 그때 붙인다.
api.put('/apps', async (c) => {
  const text = await c.req.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return c.json({ error: 'JSON 문법 오류' }, 400)
  }
  const apps = (parsed as { apps?: unknown }).apps
  if (typeof apps !== 'object' || apps === null) {
    return c.json({ error: '최상위에 apps 객체가 필요합니다' }, 400)
  }
  const path = appsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text.endsWith('\n') ? text : `${text}\n`)
  return c.json({ path })
})

const app = new Hono().route('/api', api)

const port = Number(process.env['PORT'] ?? 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`logstitch-web api: http://localhost:${port}  (runs: ${runsRoot()})`)
})
