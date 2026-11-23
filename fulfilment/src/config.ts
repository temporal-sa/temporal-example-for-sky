import { loadClientConnectConfig } from '@temporalio/envconfig';

// Reads TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY and TEMPORAL_TLS*. The config file is
// disabled so a developer's default CLI profile can't point the demo at a real Cloud namespace.
export function temporalConfig() {
  const { connectionOptions, namespace } = loadClientConnectConfig({ disableFile: true });
  return {
    connectionOptions: { ...connectionOptions, address: connectionOptions.address ?? 'localhost:7233' },
    namespace: namespace ?? 'default',
  };
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. See .env.example for what it should hold.`);
  }
  return value;
}
