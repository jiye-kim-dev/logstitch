import { useEffect, useState } from 'react'
import AppsEditor from './pages/AppsEditor.tsx'
import RunList from './pages/RunList.tsx'
import RunView from './pages/RunView.tsx'

/**
 * 해시 라우팅 — 페이지가 셋뿐이라 라우터 라이브러리를 안 쓴다.
 *   #/            run 목록
 *   #/runs/<id>   run 재렌더 뷰
 *   #/apps        apps.json 편집
 */
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export default function App(): React.JSX.Element {
  const hash = useHash()
  const runMatch = /^#\/runs\/(.+)$/.exec(hash)

  let page = <RunList />
  if (runMatch !== null) page = <RunView id={decodeURIComponent(runMatch[1] ?? '')} />
  else if (hash === '#/apps') page = <AppsEditor />

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">
          logstitch
        </a>
        <nav>
          <a href="#/" className={hash === '#/apps' ? '' : 'active'}>
            runs
          </a>
          <a href="#/apps" className={hash === '#/apps' ? 'active' : ''}>
            apps.json
          </a>
        </nav>
      </header>
      <main>{page}</main>
    </>
  )
}
