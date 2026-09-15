import { parentPort } from 'node:worker_threads'

import { workerPort } from '../csv/port.js'
import { serveTableWorker } from './worker-service.js'

if (parentPort) serveTableWorker(workerPort(parentPort))
