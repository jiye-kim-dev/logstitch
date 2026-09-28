# logstitch-web

`.runs` 원본을 재렌더하는 읽기 전용 뷰어 + `apps.json` 편집 페이지.
파싱·정렬·접기는 전부 `parser/src/index.ts` 라이브러리를 import 한다 —
로그를 해석하는 코드는 여기에 없다.

```
server/main.ts      Hono API — /api/runs, /api/runs/:id, /api/apps (GET/PUT)
client/             Vite + React — 해시 라우팅 (#/ · #/runs/<id> · #/apps)
```

## 개발

```sh
npm install
npm run dev     # Hono(8787) + Vite(5173) 동시 실행 — http://localhost:5173
```

Vite 가 `/api` 를 8787 로 프록시하므로 브라우저는 5173 만 보면 된다.
서버는 Node 22.18+ 의 타입 스트리핑으로 `.ts` 를 그대로 실행한다 (빌드 없음).

## 아직 없는 것 (의도)

- flow / contention 뷰 — 지금은 timeline 표만. `buildFlowModel` /
  `buildContentionModel` 이 이미 라이브러리에 있으므로 페이지만 붙이면 된다.
- 웹에서의 수집 실행 — 뷰어는 `.runs` 재렌더 전용. 붙일 때는 수집기의
  `--serve` (POST /collect) 를 이 서버가 프록시하는 형태로.
- apps.json 의 JSON Schema 검증 — 저장 시 문법 + `apps` 객체 존재만 검사.
