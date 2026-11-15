/** The dashboard's page (`D13`): mounts the shell into `#root`. */
import { createRoot } from 'react-dom/client'
import { App } from './shell.tsx'

createRoot(document.getElementById('root')!).render(<App />)
