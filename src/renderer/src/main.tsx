import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PipApp } from './components/pip/PipApp'
import './styles/globals.css'

// A floating chat window is the same renderer opened with ?pip=<task id>
const pipTaskId = new URLSearchParams(window.location.search).get('pip')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{pipTaskId ? <PipApp taskId={pipTaskId} /> : <App />}</React.StrictMode>
)
