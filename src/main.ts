import { h, render } from 'preact'

import { App } from './components/app'

const check = setInterval(() => {
  if (!document.body) return
  clearInterval(check)
  const root = document.createElement('div')
  root.id = 'laplace-chatterbox-root'
  document.body.appendChild(root)
  render(h(App, null), root)
}, 100)
