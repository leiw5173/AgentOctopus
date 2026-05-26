import fs from 'fs';
import path from 'path';

// Monotonic counter guarantees correct sort order even when multiple snapshots
// are created within the same millisecond.
let globalSeq = 0;

export function shadowCopy(skillFilePath: string, evolutionDir: string, maxHistorySnapshots: number): void {
  const historyDir = path.join(evolutionDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  if (!fs.existsSync(skillFilePath)) return;

  // Use a zero-padded global sequence number so filenames always sort in
  // creation order, regardless of clock resolution or millisecond collisions.
  globalSeq++;
  const snapshotPath = path.join(historyDir, `${String(globalSeq).padStart(8, '0')}.md`);
  fs.copyFileSync(skillFilePath, snapshotPath);

  // Prune old snapshots (oldest first)
  let files = listSnapshots(evolutionDir);
  while (files.length > maxHistorySnapshots) {
    fs.unlinkSync(path.join(historyDir, files[0]));
    files = files.slice(1);
  }
}

export function listSnapshots(evolutionDir: string): string[] {
  const historyDir = path.join(evolutionDir, 'history');
  if (!fs.existsSync(historyDir)) return [];

  return fs.readdirSync(historyDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

export function rollback(skillFilePath: string, evolutionDir: string, index?: number): void {
  const files = listSnapshots(evolutionDir);
  if (files.length === 0) throw new Error('No snapshots available for rollback');

  let targetIdx: number;
  if (index !== undefined) {
    if (index < 0 || index >= files.length) {
      throw new Error(`Snapshot index ${index} out of range (0–${files.length - 1})`);
    }
    targetIdx = index;
  } else {
    // Default: "go back one step" — restore second-to-last snapshot.
    // The last snapshot is the most recently saved version (what we already have);
    // rolling back means going one step earlier.
    targetIdx = files.length >= 2 ? files.length - 2 : 0;
  }

  const historyDir = path.join(evolutionDir, 'history');
  const targetPath = path.join(historyDir, files[targetIdx]);

  // Save current state as a new snapshot before overwriting
  shadowCopy(skillFilePath, evolutionDir, 1000); // high limit; caller prunes if needed

  fs.copyFileSync(targetPath, skillFilePath);
}

export function clearSnapshots(evolutionDir: string): void {
  const historyDir = path.join(evolutionDir, 'history');
  if (fs.existsSync(historyDir)) {
    fs.rmSync(historyDir, { recursive: true, force: true });
  }
}
