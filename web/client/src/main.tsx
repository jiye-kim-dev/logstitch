import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('#root 가 없습니다')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
