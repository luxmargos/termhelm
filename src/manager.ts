import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const supervisorRegistryDirectory = join(tmpdir(), 'terminal-windows-supervisors');

interface SupervisorRecord {
  pid: number;
  label: string;
  shutdownTokenPath: string;
  shutdownStateDirectory?: string;
  targets?: { title: string }[];
  createdAt: string;
}

function supervisorRegistryFileName(label: string): string {
  return `${label.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`;
}

export function supervisorRegistryPath(label: string): string {
  return join(supervisorRegistryDirectory, supervisorRegistryFileName(label));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/fi', `PID eq ${pid}`], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOwnedSupervisorRecord(record: Partial<SupervisorRecord>): record is SupervisorRecord {
  return typeof record.pid === 'number' && typeof record.label === 'string' && typeof record.shutdownTokenPath === 'string';
}

function readSupervisorRecord(label: string): SupervisorRecord | null {
  const path = supervisorRegistryPath(label);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<SupervisorRecord>;
    if (!isOwnedSupervisorRecord(record)) return null;
    if (!isProcessAlive(record.pid)) {
      rmSync(path, { force: true });
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function writeSupervisorRecord(label: string, record: SupervisorRecord): void {
  mkdirSync(supervisorRegistryDirectory, { recursive: true });
  writeFileSync(supervisorRegistryPath(label), JSON.stringify(record, null, 2), 'utf8');
}

export function removeSupervisorRecord(label: string): void {
  rmSync(supervisorRegistryPath(label), { force: true });
}

export function removeSupervisorRecordIfOwned(label: string, pid: number): void {
  const record = readSupervisorRecord(label);
  if (record?.pid === pid) removeSupervisorRecord(label);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requestPreviousSupervisorShutdown(label: string): SupervisorRecord | null {
  const record = readSupervisorRecord(label);
  if (!record) return null;
  rmSync(record.shutdownTokenPath, { force: true });
  return record;
}

function waitForSupervisorShutdown(supervisors: SupervisorRecord[], timeoutMs: number): boolean {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (supervisors.every(supervisor => !isProcessAlive(supervisor.pid))) return true;
    sleepSync(200);
  }
  return supervisors.every(supervisor => !isProcessAlive(supervisor.pid));
}

export function replacePreviousManagedTerminalWindows(labels: string[], currentLabel: string, timeoutMs: number): void {
  const supervisors = labels
    .filter(label => label !== currentLabel)
    .map(requestPreviousSupervisorShutdown)
    .filter((record): record is SupervisorRecord => record !== null);
  const currentSupervisor = requestPreviousSupervisorShutdown(currentLabel);
  if (currentSupervisor) supervisors.push(currentSupervisor);
  if (supervisors.length > 0 && !waitForSupervisorShutdown(supervisors, timeoutMs)) {
    const labelsText = supervisors.map(supervisor => supervisor.label).join(', ');
    throw new Error(`Timed out while waiting for previous terminal supervisors to stop: ${labelsText}`);
  }
}

export function createSupervisorRecord(input: { label: string; shutdownTokenPath: string; shutdownStateDirectory: string; targets: { title: string }[] }): SupervisorRecord {
  return { pid: process.pid, label: input.label, shutdownTokenPath: input.shutdownTokenPath, shutdownStateDirectory: input.shutdownStateDirectory, targets: input.targets.map(target => ({ title: target.title })), createdAt: new Date().toISOString() };
}

export function shutdownCompletePath(directory: string, title: string): string {
  return join(directory, `${basename(title).replace(/[^a-zA-Z0-9_.-]/g, '_')}.done`);
}
