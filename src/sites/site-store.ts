import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuilderDoc } from "../builder/types.js";

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface SiteRecord {
  slug: string;
  /** The whiteboard flow this site was published from. */
  flowDocId: string;
  title: string;
  /** Markdown shown to everyone, next to the sign-in form. */
  publicMd: string;
  /** Markdown shown only to signed-in users. */
  membersMd: string;
  /** Copy of the flow at publish time. Later whiteboard edits need a republish. */
  flow: BuilderDoc;
  publishedAt: number;
}

/**
 * Site records in one JSON file, plus each site's generated HTML in its own folder:
 *   <dir>/sites.json
 *   <dir>/<slug>/index.html     public page with the sign-in form
 *   <dir>/<slug>/members.html   served only with a valid session
 */
export class SiteStore {
  private sites = new Map<string, SiteRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, "sites.json");
  }

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.file, "utf8")) as SiteRecord[];
      this.sites = new Map(list.map((s) => [s.slug, s]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  list(): SiteRecord[] {
    return [...this.sites.values()];
  }

  get(slug: string): SiteRecord | undefined {
    return this.sites.get(slug);
  }

  forFlow(flowDocId: string): SiteRecord | undefined {
    for (const s of this.sites.values()) if (s.flowDocId === flowDocId) return s;
    return undefined;
  }

  pagePath(slug: string, page: "index" | "members"): string {
    if (!SLUG_RE.test(slug)) throw new Error("Bad slug");
    return join(this.dir, slug, `${page}.html`);
  }

  async put(site: SiteRecord, pages: { index: string; members: string }): Promise<void> {
    const folder = dirname(this.pagePath(site.slug, "index"));
    await mkdir(folder, { recursive: true });
    await writeAtomic(this.pagePath(site.slug, "index"), pages.index);
    await writeAtomic(this.pagePath(site.slug, "members"), pages.members);
    this.sites.set(site.slug, site);
    await this.flush();
  }

  async delete(slug: string): Promise<void> {
    if (!this.sites.delete(slug)) return;
    await rm(dirname(this.pagePath(slug, "index")), { recursive: true, force: true });
    await this.flush();
  }

  private flush(): Promise<void> {
    const text = JSON.stringify([...this.sites.values()], null, 2);
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeAtomic(this.file, text);
    });
    return this.writing;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}
