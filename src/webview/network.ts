import './styles/index.css'
import './styles/canvas.css'

import { mount } from 'svelte'

import Network from './network/Network.svelte'
mount(Network, { target: document.getElementById('app')! })
