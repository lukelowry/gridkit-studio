import './styles/index.css'

import { mount } from 'svelte'

import Export from './export/Export.svelte'
mount(Export, { target: document.getElementById('app')! })
