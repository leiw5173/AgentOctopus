import fs from 'fs';
import path from 'path';

export function shadowCopy(skillFilePath: string, evolutionDir: string, maxHistorySnapshots: number): void {
  const historyDir = path.join(evolutionDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  if (!fs.existsSync(skillFilePath)) return;

  // Use timestamp + monotonic sequence so filenames are unique and sort chronologically.
  // Format: YYYY-MM-DDTHH-MM-SS-mmm-NNNN.md (mmm = ms, NNNN = zero-padded sequence within this ms)
  const ts = new Date().toISOString().replace(/[:]/g, '-').replace('.', '-').replace(/Z$/, '');
  let snapshotPath = path.join(historyDir, `${ts}-0000.md`);
  let seq = 0;
  while (fs.existsSync(snapshotPath)) {
    seq++;
    snapshotPath = path.join(historyDir, `${ts}-${String(seq).padStart(4, '0')}.md`);
  }
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
