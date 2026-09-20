import { expose } from 'comlink';
import { createRouteHistoryStore } from './store';

expose(createRouteHistoryStore());
