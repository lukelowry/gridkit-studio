import './styles/index.css'

import { mount } from 'svelte'

import Case from './case/Case.svelte'
mount(Case, { target: document.getElementById('app')! })
