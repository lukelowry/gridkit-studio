import './style.css'

import { mount, unmount } from 'svelte'

import Table from './Table.svelte'
const app = mount(Table, { target: document.querySelector('#table')! })
window.addEventListener(
  'pagehide',
  () => {
    void unmount(app)
  },
  { once: true },
)
