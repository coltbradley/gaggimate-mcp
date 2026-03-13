import * as fs from "node:fs";
import * as path from "node:path";

export class ShotCache {
  private shotsDir: string;

  constructor(dataDir: string) {
    this.shotsDir = path.join(dataDir, "shots");
    if (!fs.existsSync(this.shotsDir)) {
      fs.mkdirSync(this.shotsDir, { recursive: true });
    }
  }

  private filePath(shotId: string): string {
    return path.join(this.shotsDir, `${shotId}.json`);
  }

  write(shotId: string, data: any): void {
    fs.writeFileSync(this.filePath(shotId), JSON.stringify(data, null, 2));
  }

  read(shotId: string): any | null {
    try {
      const raw = fs.readFileSync(this.filePath(shotId), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  latest(): any | null {
    const ids = this.listIds();
    if (ids.length === 0) return null;
    const maxId = ids.reduce((a, b) => (parseInt(a, 10) > parseInt(b, 10) ? a : b));
    return this.read(maxId);
  }

  newSince(sinceId: string): any[] {
    const threshold = parseInt(sinceId, 10);
    return this.listIds()
      .filter((id) => parseInt(id, 10) > threshold)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .map((id) => this.read(id))
      .filter((s) => s !== null);
  }

  prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const id of this.listIds()) {
      try {
        const stat = fs.statSync(this.filePath(id));
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(this.filePath(id));
        }
      } catch {
        // best effort
      }
    }
  }

  private listIds(): string[] {
    try {
      return fs.readdirSync(this.shotsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    } catch {
      return [];
    }
  }
}
