import express, { Request, Response } from 'express';
import { config } from './config';
import { logger } from './logger';
import { amiListener } from './ami';
import { formatLocalTimestamp } from './utils';

let server: any = null;
let isShuttingDown = false;

async function startServer(): Promise<void> {
  if (!config.server.enabled) {
    logger.info('HTTP server is disabled');
    return;
  }

  const app = express();
  app.use(express.json());

  app.set('trust proxy', true);

  // Middleware to authenticate API token
  const authenticateToken = (req: Request, res: Response, next: any): void => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Authentication token required',
        message: 'Please provide a valid API token in Authorization header',
      });
      return;
    }

    if (token !== config.server.apiToken) {
      logger.warn('Invalid API token attempt', {
        ip: req.ip,
        path: req.path,
      });
      res.status(403).json({
        success: false,
        error: 'Invalid token',
        message: 'The provided API token is invalid',
      });
      return;
    }

    next();
  };

  app.get('/', (_req: Request, res: Response): void => {
    res.json({
      message: 'API lấy dữ liệu từ AMI của Sangoma PBX/FreePBX và gửi webhook đến CRM',
      version: '1.0.0',
      author: 'Duler@CloudGO',
    });
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: formatLocalTimestamp(),
      uptime: process.uptime(),
    });
  });

  // Readiness check endpoint
  app.get('/ready', (_req: Request, res: Response) => {
    if (isShuttingDown) {
      res.status(503).json({
        status: 'not ready',
        reason: 'shutting down',
      });
    } else {
      res.json({
        status: 'ready',
        timestamp: formatLocalTimestamp(),
      });
    }
  });

  // Click2Call API endpoint
  app.post('/api/click2call', authenticateToken, async (req: Request, res: Response) => {
    try {
      const { extension, phoneNumber } = req.body;

      // Validate required parameters
      if (!extension) {
        return res.status(400).json({
          success: false,
          error: 'Missing parameter',
          message: 'Extension is required',
        });
      }

      if (!phoneNumber) {
        return res.status(400).json({
          success: false,
          error: 'Missing parameter',
          message: 'Phone number is required',
        });
      }

      // Validate extension format (should be numeric)
      if (!/^\d+$/.test(extension.toString())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid parameter',
          message: 'Extension must be numeric',
        });
      }

      // Validate phone number format (should be numeric, may include + for international)
      if (!/^\+?\d+$/.test(phoneNumber.toString().replace(/[\s\-\(\)]/g, ''))) {
        return res.status(400).json({
          success: false,
          error: 'Invalid parameter',
          message: 'Phone number format is invalid',
        });
      }

      logger.info('Click2call request received', {
        extension,
        phoneNumber,
        ip: req.ip,
      });

      // Execute click2call
      const result = await amiListener.click2call(extension, phoneNumber);

      if (result.success) {
        return res.json({
          success: true,
          message: result.message,
          data: {
            extension,
            phoneNumber,
            actionId: result.actionId,
          },
        });
      } else {
        return res.status(500).json({
          success: false,
          error: 'Call initiation failed',
          message: result.message,
        });
      }
    } catch (error: any) {
      logger.error('Error processing click2call request', {
        error: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: 'An error occurred while processing the request',
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
