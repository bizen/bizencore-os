import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ConvexClientProvider } from './components/ConvexClientProvider.tsx'
import { applyTheme, readTheme } from './lib/theme.ts'

applyTheme(readTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConvexClientProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
