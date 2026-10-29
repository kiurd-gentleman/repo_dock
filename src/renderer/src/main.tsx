import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './agents.css'
import './gitops.css'
import './overview.css'

createRoot(document.getElementById('root')!).render(<App />)
