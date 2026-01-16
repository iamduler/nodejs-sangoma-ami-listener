import express, { Request, Response } from 'express';
import { config } from './config';
import { logger } from './logger';
import { amiListener } from './ami';

let server: any = null;
let isShuttingDown = false;

async function startServer(): Promise<void> {
  if (!config.server.enabled) {
    logger.info('HTTP server is disabled');
    return;
  }

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness check endpoint
  app.get('/ready', (req: Request, res: Response) => {
    if (isShuttingDown) {
      res.status(503).json({
        status: 'not ready',
        reason: 'shutting down',
      });
    } else {
      res.json({
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server = app.listen(config.server.port, () => {
      logger.info('HTTP server started', { port: config.server.port });
      resolve();
    });

    server.on('error', (error: Error) => {
      logger.error('HTTP server error', { error: error.message });
      reject(error);
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown`);

  try {
    // Stop accepting new connections
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    // Stop AMI listener
    await amiListener.stop();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error: any) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    logger.info('Starting AMI Listener service', {
      version: '1.0.0',
      nodeVersion: process.version,
      pid: process.pid,
    });

    // Start HTTP server
    await startServer();

    // Start AMI listener
    await amiListener.start();

    // Setup signal handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error: Error) => {
      logger.error('Uncaught exception', { error: error.message, stack: error.stack });
      shutdown('uncaughtException').then(() => process.exit(1));
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      logger.error('Unhandled promise rejection', {
        reason: reason?.message || String(reason),
        promise: String(promise),
      });
    });

    logger.info('AMI Listener service started successfully');
  } catch (error: any) {
    logger.error('Failed to start service', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Fatal error in main', { error: error.message, stack: error.stack });
  process.exit(1);
});
