import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from project root
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

export interface Config {
  ami: {
    host: string;
    port: number;
    username: string;
    secret: string;
    reconnectInterval: number;
    reconnectMaxAttempts: number;
  };
  webhook: {
    url: string;
    timeout: number;
    retryMaxAttempts: number;
    retryInitialDelay: number;
    retryMaxDelay: number;
    retryMultiplier: number;
  };
  server: {
    port: number;
    enabled: boolean;
  };
  logging: {
    level: string;
    fileEnabled: boolean;
    fileDirectory: string;
    retentionDays: number;
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && !defaultValue) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value || defaultValue!;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

export const config: Config = {
  ami: {
    host: getEnvVar('AMI_HOST'),
    port: getEnvNumber('AMI_PORT', 5038),
    username: getEnvVar('AMI_USERNAME'),
    secret: getEnvVar('AMI_SECRET'),
    reconnectInterval: getEnvNumber('AMI_RECONNECT_INTERVAL', 5000),
    reconnectMaxAttempts: getEnvNumber('AMI_RECONNECT_MAX_ATTEMPTS', -1), // -1 = infinite
  },
  webhook: {
    url: getEnvVar('WEBHOOK_URL'),
    timeout: getEnvNumber('WEBHOOK_TIMEOUT', 10000),
    retryMaxAttempts: getEnvNumber('WEBHOOK_RETRY_MAX_ATTEMPTS', 5),
    retryInitialDelay: getEnvNumber('WEBHOOK_RETRY_INITIAL_DELAY', 1000),
    retryMaxDelay: getEnvNumber('WEBHOOK_RETRY_MAX_DELAY', 30000),
    retryMultiplier: getEnvNumber('WEBHOOK_RETRY_MULTIPLIER', 2),
  },
  server: {
    port: getEnvNumber('SERVER_PORT', 3000),
    enabled: getEnvBoolean('SERVER_ENABLED', true),
  },
  logging: {
    level: getEnvVar('LOG_LEVEL', 'info'),
    fileEnabled: getEnvBoolean('LOG_FILE_ENABLED', true),
    fileDirectory: getEnvVar('LOG_FILE_DIRECTORY', './logs'),
    retentionDays: getEnvNumber('LOG_RETENTION_DAYS', 90),
  },
};
