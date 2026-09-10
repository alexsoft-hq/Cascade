// Next.js: the router comes from a hook, and a link is an element.
import Link from 'next/link'
import { useRouter } from 'next/router'
import React from 'react'

export function CrateList() {
  const router = useRouter()

  const openCrate = (crateNo: string) => {
    router.push(`/crates/${crateNo}`)
  }

  const goHome = () => {
    router.replace('/')
  }

  const warmUp = () => router.prefetch('/crates/new')

  const openWithQuery = () => router.push({ pathname: '/crates/new', query: { from: 'list' } })

  return (
    <div onClick={() => { openCrate('1'); goHome(); warmUp(); openWithQuery() }}>
      <Link href="/crates/archive">Archive</Link>
    </div>
  )
}
