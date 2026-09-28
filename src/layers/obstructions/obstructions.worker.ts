import { expose } from 'comlink';
import { createObstructionWorker } from './worker-data';

expose(createObstructionWorker());
