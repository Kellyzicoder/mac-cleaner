import type { CleanerApi } from '../shared/types';

declare global {
  interface Window {
    cleaner: CleanerApi;
  }
}

export {};
