import { expose } from 'comlink';
import { createLandingWorker } from './landing-planner';
expose(createLandingWorker());
