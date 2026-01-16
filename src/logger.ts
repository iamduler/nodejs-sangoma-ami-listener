import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from './config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: any;
}

class Logger {
  private level: LogLevel;
  private fileEnabled: boolean;
  private logDirectory: string;
  private retentionDays: number;
  private currentDate: string = '';
  private cleanupScheduled: boolean = false;

  constructor(level: string = 'info', fileEnabled: boolean = true, logDirectory: string = './logs', retentionDays: number = 90) {
    this.level = (level.toLowerCase() as LogLevel) || 'info';
    this.fileEnabled = fileEnabled;
    this.logDirectory = logDirectory;
    this.retentionDays = retentionDays;
    this.currentDate = this.getCurrentDateString();
    
    if (this.fileEnabled) {
      this.initializeLogDirectory().catch((error) => {
        console.error('Failed to initialize log directory:', error);
      });
    }
  }

  private getCurrentDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getLogFilePath(): string {
    const dateString = this.getCurrentDateString();
    const fileName = `${dateString}.log`;
    return path.join(this.logDirectory, fileName);
  }

  private async initializeLogDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.logDirectory, { recursive: true });
    } catch (error: any) {
      console.error('Failed to create log directory:', error.message);
    }
  }

  private async writeToFile(content: string): Promise<void> {
    if (!this.fileEnabled) {
      return;
    }

    try {
      // Check if date changed and schedule cleanup if needed
      const newDate = this.getCurrentDateString();
      if (newDate !== this.currentDate) {
        this.currentDate = newDate;
        if (!this.cleanupScheduled) {
          this.scheduleCleanup();
        }
      }

      const logPath = this.getLogFilePath();
      await fs.appendFile(logPath, content + '\n', 'utf8');
    } catch (error: any) {
      // Silently fail file writing to avoid breaking the application
      // Only log to console if it's a critical error
      if (error.code !== 'ENOENT') {
        console.error('Failed to write to log file:', error.message);
      }
    }
  }

  private async scheduleCleanup(): Promise<void> {
    this.cleanupScheduled = true;
    
    // Run cleanup in background, don't wait for it
    this.cleanupOldLogs().catch((error) => {
      console.error('Failed to cleanup old logs:', error);
    }).finally(() => {
      this.cleanupScheduled = false;
    });
  }

  private async cleanupOldLogs(): Promise<void> {
    try {
      const files = await fs.readdir(this.logDirectory);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      const logFilePattern = /^\d{4}-\d{2}-\d{2}\.log$/;

      for (const file of files) {
        if (!logFilePattern.test(file)) {
          continue;
        }

        // Extract date from filename (YYYY-MM-DD.log)
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
        if (!dateMatch) {
          continue;
        }

        const fileDate = new Date(dateMatch[1]);
        if (fileDate < cutoffDate) {
          const filePath = path.join(this.logDirectory, file);
          try {
            await fs.unlink(filePath);
            console.log(`Deleted old log file: ${file}`);
          } catch (error: any) {
            console.error(`Failed to delete log file ${file}:`, error.message);
          }
        }
      }
    } catch (error: any) {
      // If directory doesn't exist or can't be read, that's okay
      if (error.code !== 'ENOENT') {
        console.error('Failed to cleanup old logs:', error.message);
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.level);
    const messageIndex = levels.indexOf(level);
    return messageIndex >= currentIndex;
  }

  private async log(level: LogLevel, message: string, meta?: Record<string, any>): Promise<void> {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };

    const output = JSON.stringify(entry);
    console.log(output);

    // Write to file asynchronously (don't await to avoid blocking)
    if (this.fileEnabled) {
      this.writeToFile(output).catch((error) => {
        // Only log critical errors to console
        if (error.code !== 'ENOENT') {
          console.error('Failed to write log to file:', error.message);
        }
      });
    }
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.log('debug', message, meta).catch(() => {
      // Ignore errors in logging
    });
  }

  info(message: string, meta?: Record<string, any>): void {
    this.log('info', message, meta).catch(() => {
      // Ignore errors in logging
    });
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.log('warn', message, meta).catch(() => {
      // Ignore errors in logging
    });
  }

  error(message: string, meta?: Record<string, any>): void {
    this.log('error', message, meta).catch(() => {
      // Ignore errors in logging
    });
  }

  // Method to manually trigger cleanup (useful for testing or manual cleanup)
  async cleanup(): Promise<void> {
    await this.cleanupOldLogs();
  }
}

export const logger = new Logger(
  config.logging.level,
  config.logging.fileEnabled,
  config.logging.fileDirectory,
  config.logging.retentionDays
);
