// react-router: the hook hands back the navigate function itself.
import { Link, Navigate, redirect, useNavigate } from 'react-router-dom'
import React from 'react'

export function ShipmentPanel({ done }) {
  const go = useNavigate()
  const openShipment = (shipmentNo) => go(`/shipments/${shipmentNo}`)
  const bail = () => redirect('/shipments')
  return (
    <div onClick={() => { openShipment('1'); bail() }}>
      <Link to="/shipments/new">New</Link>
      {done ? <Navigate to="/shipments" /> : null}
    </div>
  )
}
