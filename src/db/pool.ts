import { Pool, type PoolConfig } from 'pg';

export function createPool(connectionString: string): Pool {
  const config: PoolConfig = {
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  return new Pool(config);
}
