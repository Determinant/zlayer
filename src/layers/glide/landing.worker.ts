import { expose } from 'comlink';
import { createLandingDisplayWorker } from './landing-display';
expose(createLandingDisplayWorker());
