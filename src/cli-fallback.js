import { spawn } from 'node:child_process';

export class CodexCliFallback {
  constructor({ command = 'codex', args = ['exec'], cwd = process.cwd(), spawnImpl = spawn } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.spawn = spawnImpl;
  }

  async runPrompt(prompt) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, [...this.args, prompt], {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `codex exec exited with ${code}`));
      });
    });
  }
}
