import path from 'node:path';
import { config, useSupabase } from '../config.js';
import { LocalRepo } from './localRepo.js';
import type { Repo } from './repo.js';
import { SupabaseRepo } from './supabaseRepo.js';

export const repo: Repo = useSupabase
  ? new SupabaseRepo(config.supabaseUrl, config.supabaseServiceRoleKey)
  : new LocalRepo(path.resolve(config.localDataDir));

export async function initRepo() {
  if (repo instanceof SupabaseRepo) await repo.syncSeeds();
}

export * from './types.js';
