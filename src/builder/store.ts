import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BuilderDoc } from "./types.js";

/**
 * Keeps whiteboard flows in memory and mirrors them to a JSON file,
 * so saved flows survive a restart. Writes go to a temp file first, then replace the real one.
 */
export class FlowDocStore {
  private docs = new Map<string, BuilderDoc>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as BuilderDoc[];
      this.docs = new Map(parsed.map((d) => [d.id, d]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  list(): BuilderDoc[] {
    return [...this.docs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): BuilderDoc | undefined {
    return this.docs.get(id);
  }

  async put(doc: BuilderDoc): Promise<void> {
    this.docs.set(doc.id, doc);
    await this.flush();
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.docs.delete(id);
    if (existed) await this.flush();
    return existed;
  }

  private flush(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const snapshot = JSON.stringify(this.list(), null, 2);
    // Chain after the previous write even if it failed, so one bad write does not block later ones.
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return this.writing;
  }
}
