import './theme.css'

import { mount } from 'svelte'

import Simulation from './Simulation.svelte'
mount(Simulation, { target: document.getElementById('app')! })
