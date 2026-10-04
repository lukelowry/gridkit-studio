import './styles/index.css'
import './styles/canvas.css'

import { mount } from 'svelte'

import Monitor from './monitor/Monitor.svelte'
mount(Monitor, { target: document.getElementById('app')! })
