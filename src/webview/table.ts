import './theme.css'

import { mount } from 'svelte'

import Table from './Table.svelte'
mount(Table, { target: document.getElementById('app')! })
