// The browser's own address bar, which every router ends up asking for.
export function leaveForPortal() {
  window.location.href = '/portal/home'
}

export function bounce() {
  location.assign('/portal/bounce')
}

export function swap() {
  window.location.replace('/portal/swap')
}
