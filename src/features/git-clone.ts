import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Shallow-clone a remote into a unique temp directory. Caller must remove the directory when done.
 */
export async function gitCloneShallowToTemp(gitUrl: string, tmpPrefix: string): Promise<string> {
	const tmpDir = path.join(os.tmpdir(), `${tmpPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(tmpDir, { recursive: true });
	try {
		await execFileAsync('git', ['clone', '--depth=1', '--', gitUrl, tmpDir], {
			windowsHide: true,
			maxBuffer: 10 * 1024 * 1024
		});
	} catch (error) {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		throw new Error(`git clone failed for ${gitUrl}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return tmpDir;
}
