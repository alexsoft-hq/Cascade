// A composable that receives the api function it should use. It never names
// one, which is the whole point: the screen that hands one over is the only
// place the dependency is written down.
export function usePagedList(source, label) {
  return { source, label, reload: () => source() }
}
