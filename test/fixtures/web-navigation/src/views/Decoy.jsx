// Nothing here is a navigation, and each line is a way the rule could go wrong.
import Cookies from 'js-cookie'
import { Link } from 'some-ui-kit'
import React from 'react'

export function Decoy({ queue }) {
  // `push` on something this file never bound to a router is not a navigation.
  queue.push('/queue/next')
  const size = Cookies.get('/size/large')
  // A `Link` from a component library is a component, not a router link.
  return <Link href="/marketing/pricing">{size}</Link>
}
