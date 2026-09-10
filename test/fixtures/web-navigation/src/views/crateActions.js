// Vue, composition style: the hook's value is bound to a name of this file's
// own choosing, which is why the rule reads the hook and not the name.
import { useRouter } from 'vue-router'

export function useCrateActions() {
  const nav = useRouter()
  const openCrate = (crateNo) => nav.push(`/crates/${crateNo}`)
  return { openCrate }
}
