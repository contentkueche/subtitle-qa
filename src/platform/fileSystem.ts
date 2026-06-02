import { Logger } from "../domain/logger";
import { decodeUtf8, encodeUtf8 } from "./utf8";

export interface PickedJsonTextFile {
  name: string;
  text: string;
  path?: string;
  location?: string;
}

export class UxpFileSystem {
  private readonly fs: any;
  private readonly uxp: any;
  private readonly os: any;
  private readonly process: any;

  constructor(private readonly logger: Logger) {
    this.fs = optionalRequire("fs");
    this.uxp = optionalRequire("uxp");
    this.os = optionalRequire("os");
    this.process = optionalRequire("process");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.logger.debug("Reading file bytes.", { path });

    if (this.fs?.promises?.readFile) {
      return normalizeBytes(await this.fs.promises.readFile(path));
    }
    if (typeof this.fs?.readFile === "function") {
      const raw = await this.fs.readFile(path);
      return normalizeBytes(raw);
    }
    if (typeof this.fs?.readFileSync === "function") {
      return normalizeBytes(this.fs.readFileSync(path));
    }

    const entry = await this.getEntryWithUrl(path);
    if (entry?.read) {
      return normalizeBytes(await entry.read({ format: this.uxp?.storage?.formats?.binary }));
    }

    throw new Error("No UXP file API capable of reading arbitrary project files is available.");
  }

  async readTextFile(path: string): Promise<string> {
    return decodeUtf8(await this.readFileBytes(path));
  }

  async writeTextFile(path: string, text: string): Promise<void> {
    await this.writeFileBytes(path, encodeUtf8(text));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.logger.debug("Writing file bytes.", { path, byteLength: bytes.byteLength });

    if (this.fs?.promises?.writeFile) {
      await this.fs.promises.writeFile(path, bytes);
      return;
    }
    if (typeof this.fs?.writeFile === "function") {
      await this.fs.writeFile(path, bytes);
      return;
    }
    if (typeof this.fs?.writeFileSync === "function") {
      this.fs.writeFileSync(path, bytes);
      return;
    }

    const entry = await this.getEntryWithUrl(path);
    if (entry?.write) {
      await entry.write(bytes, { format: this.uxp?.storage?.formats?.binary });
      return;
    }

    throw new Error("No UXP file API capable of writing arbitrary project files is available.");
  }

  async copyFile(source: string, destination: string): Promise<void> {
    this.logger.info("Creating project backup.", { source, destination });

    if (this.fs?.promises?.copyFile) {
      await this.fs.promises.copyFile(source, destination);
      return;
    }
    if (typeof this.fs?.copyFile === "function") {
      await this.fs.copyFile(source, destination);
      return;
    }
    if (typeof this.fs?.copyFileSync === "function") {
      this.fs.copyFileSync(source, destination);
      return;
    }

    await this.writeFileBytes(destination, await this.readFileBytes(source));
  }

  async pickJsonTextFile(): Promise<PickedJsonTextFile | undefined> {
    const pickerHost = this.resolveFilePickerHost();
    if (!pickerHost) {
      throw new Error("This UXP host does not expose a glossary file picker API.");
    }

    const picked = await pickerHost.getFileForOpening({
      types: ["json"],
      allowMultiple: false
    });
    const file = Array.isArray(picked) ? picked[0] : picked;
    if (!file) {
      return undefined;
    }

    const nativePath =
      typeof file.nativePath === "string"
        ? file.nativePath
        : this.uxp?.storage?.localFileSystem?.getNativePath?.(file);

    if (typeof file.read === "function") {
      const raw = await this.readPickedFile(file);
      return {
        name: file.name ?? "glossary.json",
        text: raw,
        path: nativePath,
        location: nativePath ?? this.describeEntryLocation(file)
      };
    }

    if (nativePath) {
      return { name: file.name ?? "glossary.json", text: await this.readTextFile(nativePath), path: nativePath, location: nativePath };
    }

    throw new Error("Selected glossary file cannot be read by this UXP host.");
  }

  async loadOrCreateStandardGlossary(defaultText: string): Promise<{ name: string; text: string; location?: string }> {
    const local = this.uxp?.storage?.localFileSystem;
    if (!local?.getDataFolder) {
      throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
    }

    const folder = await local.getDataFolder();
    const fileName = "subtitle-qa-glossary.json";
    let file = await this.findFileInFolder(folder, fileName);

    if (!file) {
      if (typeof folder?.createFile !== "function") {
        throw new Error("This UXP host cannot create a standard glossary file in plugin-data.");
      }
      file = await folder.createFile(fileName, { overwrite: false });
      await this.writeTextToFile(file, defaultText);
      this.logger.info("Created standard glossary file.", { fileName });
    }

    const text = await this.readPickedFile(file);
    return {
      name: file.name ?? fileName,
      text,
      location: this.describeEntryLocation(file)
    };
  }

  async saveStandardGlossary(text: string): Promise<{ name: string; location?: string }> {
    const saved = await this.writeDataFile("subtitle-qa-glossary.json", text);
    return { name: saved.name, location: saved.location };
  }

  async loadOrCreateGlossarySettings(defaultText: string): Promise<{ name: string; text: string; location?: string }> {
    return this.loadOrCreateDataFile("subtitle-qa-glossary-settings.json", defaultText);
  }

  async saveGlossarySettings(text: string): Promise<{ name: string; location?: string }> {
    const saved = await this.writeDataFile("subtitle-qa-glossary-settings.json", text);
    return { name: saved.name, location: saved.location };
  }

  async loadOrCreateEngineSettings(defaultText: string): Promise<{ name: string; text: string; location?: string }> {
    return this.loadOrCreateDataFile("subtitle-qa-engine-settings.json", defaultText);
  }

  async saveEngineSettings(text: string): Promise<{ name: string; location?: string }> {
    const saved = await this.writeDataFile("subtitle-qa-engine-settings.json", text);
    return { name: saved.name, location: saved.location };
  }

  backupPathFor(projectPath: string): string {
    const { dir, base, ext } = splitPath(projectPath);
    const normalizedBase = base.replace(/\.subtitle-qa-backup(?:-[^.]*)?$/i, "");
    return `${dir}${normalizedBase}.subtitle-qa-backup${ext}`;
  }

  async findSharedGlossaryPath(fileName = "subtitle-qa-glossary.json"): Promise<string | undefined> {
    for (const candidate of this.sharedGlossaryCandidatePaths(fileName)) {
      if (await this.isReadableFile(candidate)) {
        return candidate;
      }
    }

    const roots = this.sharedGlossarySearchRoots();
    for (const root of roots) {
      const found = await this.findSharedGlossaryUnderRoot(root, fileName, 8);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  private async getEntryWithUrl(path: string): Promise<any> {
    const localFileSystem = this.uxp?.storage?.localFileSystem;
    if (!localFileSystem?.getEntryWithUrl) {
      return undefined;
    }
    const prefix = path.startsWith("/") ? "file://" : "file:///";
    return localFileSystem.getEntryWithUrl(`${prefix}${path}`);
  }

  private async isReadableFile(path: string): Promise<boolean> {
    try {
      if (typeof this.fs?.promises?.stat === "function") {
        const stat = await this.fs.promises.stat(path);
        return typeof stat?.isFile === "function" ? stat.isFile() : true;
      }
      await this.readFileBytes(path);
      return true;
    } catch {
      return false;
    }
  }

  private sharedGlossaryCandidatePaths(fileName: string): string[] {
    const home = this.homeDirectory();
    if (!home) {
      return [];
    }

    return [
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Dokumente", "General", "00_COMPANY_BRAIN", fileName),
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Documents", "General", "00_COMPANY_BRAIN", fileName),
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH", "contentkueche - Freigegebene Dokumente", "General", "00_COMPANY_BRAIN", fileName),
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-contentkuecheGmbH", "General", "00_COMPANY_BRAIN", fileName),
      joinFsPath(home, "OneDrive - contentkueche GmbH", "General", "00_COMPANY_BRAIN", fileName),
      joinFsPath(home, "contentkueche GmbH", "General", "00_COMPANY_BRAIN", fileName)
    ];
  }

  private sharedGlossarySearchRoots(): string[] {
    const home = this.homeDirectory();
    if (!home) {
      return [];
    }

    return [
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-SharedLibraries-contentkuecheGmbH"),
      joinFsPath(home, "Library", "CloudStorage", "OneDrive-contentkuecheGmbH"),
      joinFsPath(home, "OneDrive - contentkueche GmbH"),
      joinFsPath(home, "contentkueche GmbH")
    ];
  }

  private async findSharedGlossaryUnderRoot(root: string, fileName: string, maxDepth: number): Promise<string | undefined> {
    if (!this.fs?.promises?.readdir || !(await this.pathExists(root))) {
      return undefined;
    }

    const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || current.depth > maxDepth) {
        continue;
      }

      let entries: any[];
      try {
        entries = await this.fs.promises.readdir(current.path, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const name = String(entry?.name ?? "");
        if (!name || name === ".Trash") {
          continue;
        }

        const nextPath = joinFsPath(current.path, name);
        if (isDirectoryEntry(entry)) {
          stack.push({ path: nextPath, depth: current.depth + 1 });
          continue;
        }

        if (name === fileName && normalizedPath(nextPath).includes("/General/00_COMPANY_BRAIN/")) {
          return nextPath;
        }
      }
    }

    return undefined;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      if (typeof this.fs?.promises?.stat === "function") {
        await this.fs.promises.stat(path);
        return true;
      }
      if (typeof this.fs?.existsSync === "function") {
        return Boolean(this.fs.existsSync(path));
      }
      return false;
    } catch {
      return false;
    }
  }

  private homeDirectory(): string | undefined {
    if (typeof this.os?.homedir === "function") {
      const home = this.os.homedir();
      if (typeof home === "string" && home.length > 0) {
        return home;
      }
    }
    const env = this.process?.env;
    return env?.HOME ?? env?.USERPROFILE;
  }

  private resolveFilePickerHost(): { getFileForOpening(options: unknown): Promise<any> } | undefined {
    if (typeof this.fs?.getFileForOpening === "function") {
      return this.fs;
    }
    const local = this.uxp?.storage?.localFileSystem;
    if (typeof local?.getFileForOpening === "function") {
      return local;
    }
    return undefined;
  }

  private async readPickedFile(file: any): Promise<string> {
    const utf8 = this.uxp?.storage?.formats?.utf8;
    try {
      const content = utf8 ? await file.read({ format: utf8 }) : await file.read();
      if (typeof content === "string") {
        return content;
      }
      return decodeUtf8(normalizeBytes(content));
    } catch {
      const content = await file.read();
      if (typeof content === "string") {
        return content;
      }
      return decodeUtf8(normalizeBytes(content));
    }
  }

  private async writeTextToFile(file: any, text: string): Promise<void> {
    if (typeof file?.write !== "function") {
      throw new Error("Glossary target file is not writable in this UXP host.");
    }

    const utf8 = this.uxp?.storage?.formats?.utf8;
    if (utf8) {
      await file.write(text, { format: utf8 });
      return;
    }
    await file.write(text);
  }

  private async findFileInFolder(folder: any, fileName: string): Promise<any | undefined> {
    if (typeof folder?.getEntry === "function") {
      try {
        const entry = await folder.getEntry(fileName);
        if (entry?.isFile || typeof entry?.read === "function") {
          return entry;
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    if (typeof folder?.getEntries === "function") {
      const entries = await folder.getEntries();
      return entries.find((entry: any) => (entry?.isFile || typeof entry?.read === "function") && entry?.name === fileName);
    }

    return undefined;
  }

  private describeEntryLocation(entry: any): string | undefined {
    const local = this.uxp?.storage?.localFileSystem;
    if (typeof local?.getFsUrl === "function") {
      try {
        return String(local.getFsUrl(entry));
      } catch {
        // fall through
      }
    }
    if (typeof local?.getNativePath === "function") {
      try {
        return String(local.getNativePath(entry));
      } catch {
        // fall through
      }
    }
    if (entry?.nativePath) {
      return String(entry.nativePath);
    }
    return undefined;
  }

  private async loadOrCreateDataFile(fileName: string, defaultText: string): Promise<{ name: string; text: string; location?: string }> {
    const local = this.uxp?.storage?.localFileSystem;
    if (!local?.getDataFolder) {
      throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
    }

    const folder = await local.getDataFolder();
    let file = await this.findFileInFolder(folder, fileName);

    if (!file) {
      if (typeof folder?.createFile !== "function") {
        throw new Error(`This UXP host cannot create ${fileName} in plugin-data.`);
      }
      file = await folder.createFile(fileName, { overwrite: false });
      await this.writeTextToFile(file, defaultText);
      this.logger.info("Created plugin data file.", { fileName });
    }

    const text = await this.readPickedFile(file);
    return {
      name: file.name ?? fileName,
      text,
      location: this.describeEntryLocation(file)
    };
  }

  private async writeDataFile(fileName: string, text: string): Promise<{ name: string; location?: string }> {
    const local = this.uxp?.storage?.localFileSystem;
    if (!local?.getDataFolder) {
      throw new Error("This UXP host does not expose localFileSystem.getDataFolder().");
    }

    const folder = await local.getDataFolder();
    let file = await this.findFileInFolder(folder, fileName);
    if (!file) {
      if (typeof folder?.createFile !== "function") {
        throw new Error(`This UXP host cannot create ${fileName} in plugin-data.`);
      }
      file = await folder.createFile(fileName, { overwrite: false });
    }

    await this.writeTextToFile(file, text);
    return {
      name: file.name ?? fileName,
      location: this.describeEntryLocation(file)
    };
  }
}

export function splitPath(path: string): { dir: string; base: string; ext: string } {
  const separator = path.includes("\\") ? "\\" : "/";
  const slash = path.lastIndexOf(separator);
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  if (dot <= 0) {
    return { dir, base: file, ext: "" };
  }
  return { dir, base: file.slice(0, dot), ext: file.slice(dot) };
}

function joinFsPath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    return "";
  }

  const separator = filtered.some((part) => part.includes("\\")) ? "\\" : "/";
  const joined = filtered
    .map((part, index) => {
      if (index === 0) {
        return part.replace(/[\\/]+$/g, "");
      }
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .join(separator);

  return filtered[0].startsWith("/") ? `/${joined.replace(/^\/+/, "")}` : joined;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isDirectoryEntry(entry: any): boolean {
  if (typeof entry?.isDirectory === "function") {
    return entry.isDirectory();
  }
  return Boolean(entry?.isDirectory);
}

function optionalRequire(moduleName: string): any {
  try {
    return require(moduleName);
  } catch {
    return undefined;
  }
}

function normalizeBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof raw === "string") {
    return encodeUtf8(raw);
  }
  throw new Error("Unsupported file byte payload returned by UXP fs.");
}
