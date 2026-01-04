import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

export interface NixEvalResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

export interface NixRunnerOptions {
    cwd: string;
    timeout?: number;
}

/**
 * Utility class for running nix commands with cancellation and debouncing.
 */
export class NixRunner {
    private activeProcesses = new Map<string, ChildProcess>();
    private debounceTimers = new Map<string, NodeJS.Timeout>();

    constructor(private outputChannel: vscode.OutputChannel) { }

    /**
     * Get configuration values for nix commands.
     */
    private getConfig() {
        const config = vscode.workspace.getConfiguration('nixFlakeExplorer');
        return {
            nixArgs: config.get<string[]>('nixArgs', ['--offline']),
            experimentalFeatures: config.get<string[]>('experimentalFeatures', ['nix-command', 'flakes']),
            debounceMs: config.get<number>('debounceMs', 500),
        };
    }

    /**
     * Build the base nix command arguments.
     */
    private buildBaseArgs(): string[] {
        const { nixArgs, experimentalFeatures } = this.getConfig();
        const args: string[] = [];

        if (experimentalFeatures.length > 0) {
            args.push('--extra-experimental-features', experimentalFeatures.join(' '));
        }

        args.push(...nixArgs);
        return args;
    }

    /**
     * Cancel any running process for the given key.
     */
    cancel(key: string): void {
        const proc = this.activeProcesses.get(key);
        if (proc && !proc.killed) {
            proc.kill('SIGTERM');
            this.activeProcesses.delete(key);
        }

        const timer = this.debounceTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(key);
        }
    }

    /**
     * Cancel all running processes.
     */
    cancelAll(): void {
        for (const key of this.activeProcesses.keys()) {
            this.cancel(key);
        }
    }

    /**
     * Run a nix command with optional debouncing.
     */
    async run(
        args: string[],
        options: NixRunnerOptions,
        key?: string,
        debounce = false
    ): Promise<NixEvalResult> {
        const processKey = key ?? args.join(' ');

        // Cancel any existing process/timer for this key
        this.cancel(processKey);

        const { debounceMs } = this.getConfig();

        if (debounce) {
            return new Promise((resolve) => {
                const timer = setTimeout(async () => {
                    this.debounceTimers.delete(processKey);
                    const result = await this.executeNix(args, options, processKey);
                    resolve(result);
                }, debounceMs);
                this.debounceTimers.set(processKey, timer);
            });
        }

        return this.executeNix(args, options, processKey);
    }

    /**
     * Execute a nix command.
     */
    private executeNix(
        args: string[],
        options: NixRunnerOptions,
        processKey: string
    ): Promise<NixEvalResult> {
        return new Promise((resolve) => {
            const fullArgs = [...this.buildBaseArgs(), ...args];

            const cmdLine = `> nix ${fullArgs.join(' ')}`;
            console.log(cmdLine);
            this.outputChannel.appendLine(cmdLine);

            const proc = spawn('nix', fullArgs, {
                cwd: options.cwd,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            this.activeProcesses.set(processKey, proc);

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            const timeout = options.timeout ?? 30000;
            const timer = setTimeout(() => {
                if (!proc.killed) {
                    proc.kill('SIGTERM');
                    resolve({ success: false, error: `Command timed out after ${timeout}ms` });
                }
            }, timeout);

            proc.on('close', (code) => {
                clearTimeout(timer);
                this.activeProcesses.delete(processKey);

                if (code === 0) {
                    try {
                        const data = stdout.trim() ? JSON.parse(stdout) : null;
                        resolve({ success: true, data });
                    } catch {
                        // Not JSON, return as string
                        resolve({ success: true, data: stdout.trim() });
                    }
                } else {
                    const errorMsg = `Error: ${stderr}`;
                    console.error(errorMsg);
                    this.outputChannel.appendLine(errorMsg);
                    resolve({ success: false, error: stderr.trim() || `Exit code ${code}` });
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                this.activeProcesses.delete(processKey);
                const spawnError = `Spawn error: ${err.message}`;
                console.error(spawnError);
                this.outputChannel.appendLine(spawnError);
                resolve({ success: false, error: err.message });
            });
        });
    }

    /**
     * Evaluate an attribute path and get its children (attribute names).
     */
    async getAttrNames(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = attrPath ? `.#${attrPath}` : '.';
        const args = ['eval', '--json', flakeRef, '--apply', 'x: builtins.attrNames x'];
        return this.run(args, { cwd: flakePath }, `attrNames:${attrPath}`);
    }

    /**
     * Evaluate an attribute and get its value.
     */
    async getValue(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = `.#${attrPath}`;
        const args = ['eval', '--json', flakeRef];
        return this.run(args, { cwd: flakePath }, `value:${attrPath}`);
    }

    /**
     * Get the type of a value at an attribute path.
     */
    async getValueType(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = attrPath ? `.#${attrPath}` : '.';
        const args = ['eval', '--json', flakeRef, '--apply', 'x: builtins.typeOf x'];
        return this.run(args, { cwd: flakePath }, `type:${attrPath}`);
    }

    /**
     * Check if a value is a derivation.
     */
    async isDerivation(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = `.#${attrPath}`;
        const args = [
            'eval', '--json', flakeRef,
            '--apply', 'x: (x.type or null) == "derivation" || (x ? drvPath)'
        ];
        return this.run(args, { cwd: flakePath }, `isDrv:${attrPath}`);
    }

    /**
     * Get length of a list.
     */
    async getListLength(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = `.#${attrPath}`;
        const args = ['eval', '--json', flakeRef, '--apply', 'x: builtins.length x'];
        return this.run(args, { cwd: flakePath }, `listLen:${attrPath}`);
    }

    /**
     * Get derivation info (name, pname) for a list element.
     */
    async getListElementInfo(
        flakePath: string,
        attrPath: string,
        index: number
    ): Promise<NixEvalResult> {
        const flakeRef = `.#${attrPath}`;
        const args = [
            'eval', '--json', flakeRef,
            '--apply', `xs: let e = builtins.elemAt xs ${index}; in { 
        name = e.name or e.pname or "[${index}]"; 
        isDrv = (e.type or null) == "derivation" || (e ? drvPath);
      }`
        ];
        return this.run(args, { cwd: flakePath }, `listElem:${attrPath}[${index}]`);
    }

    /**
     * Get derivation path for an item.
     */
    async getDrvPath(flakePath: string, attrPath: string): Promise<NixEvalResult> {
        const flakeRef = `.#${attrPath}`;
        const args = ['eval', '--raw', flakeRef + '.drvPath'];
        return this.run(args, { cwd: flakePath }, `drvPath:${attrPath}`);
    }

    /**
     * Get derivation JSON via `nix derivation show`.
     */
    async getDerivationJson(flakePath: string, drvPath: string): Promise<NixEvalResult> {
        const args = ['derivation', 'show', drvPath];
        return this.run(args, { cwd: flakePath }, `drvShow:${drvPath}`);
    }

    /**
     * Run `nix flake show --json` to get top-level structure.
     */
    async flakeShow(flakePath: string): Promise<NixEvalResult> {
        const args = ['flake', 'show', '--json', '.'];
        return this.run(args, { cwd: flakePath }, 'flakeShow');
    }
}
