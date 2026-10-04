import './styles/index.css'

import { mount } from 'svelte'

import Bindings from './bindings/Bindings.svelte'
mount(Bindings, { target: document.getElementById('app')! })
