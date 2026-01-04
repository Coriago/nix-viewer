import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_FILE = path.join(os.homedir(), 'nix-viewer-debug.log');

/**
 * Simple file logger for debugging the extension.
 */
export class Logger {
    private static instance: Logger;
    private stream: fs.WriteStream;

    private constructor() {
        // Truncate log file on start
        this.stream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
        this.log('=== Nix Viewer Debug Log Started ===');
    }

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    log(message: string): void {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${message}\n`;
        this.stream.write(line);
        console.log(message);
    }

    error(message: string, error?: unknown): void {
        const timestamp = new Date().toISOString();
        let line = `[${timestamp}] ERROR: ${message}`;
        if (error) {
            line += `\n  ${String(error)}`;
            if (error instanceof Error && error.stack) {
                line += `\n  Stack: ${error.stack}`;
            }
        }
        line += '\n';
        this.stream.write(line);
        console.error(message, error);
    }

    close(): void {
        this.stream.end();
    }
}

// Export singleton accessor
export const logger = Logger.getInstance();
