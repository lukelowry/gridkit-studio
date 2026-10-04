import './styles/index.css'

import { mount } from 'svelte'

import Simulation from './simulation/Simulation.svelte'
mount(Simulation, { target: document.getElementById('app')! })
