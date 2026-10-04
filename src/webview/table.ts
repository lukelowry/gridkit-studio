import './styles/index.css'

import { mount } from 'svelte'

import Table from './table/Table.svelte'
mount(Table, { target: document.getElementById('app')! })
