import './style.css'

import { mount } from 'svelte'

import Simulation from './Simulation.svelte'
mount(Simulation, { target: document.querySelector('#simulation')! })
