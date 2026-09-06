import { Routes, Route } from 'react-router-dom'
import ThingPanel from '@/react/ThingPanel'
import ChildPanel from '@/react/ChildPanel'

export function pingHealth() {
  return fetch('/health', { method: 'POST' })
}

export default function App() {
  return (
    <Routes>
      <Route path="/r" element={<ThingPanel />}>
        <Route path="child" element={<ChildPanel />} />
      </Route>
    </Routes>
  )
}
