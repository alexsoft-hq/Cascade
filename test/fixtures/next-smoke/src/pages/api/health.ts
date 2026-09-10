export default function health(req: unknown, res: { end: (s: string) => void }) {
  res.end('ok')
}
