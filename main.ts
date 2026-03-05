import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ToggleComponent,
  debounce,
} from "obsidian";
import { diffLines, diffWords } from "diff";
import { debug } from "./utils";

interface MigrationsSettings {
  createPatchFiles: boolean;
  patchFolder: string;
  showLineNumbers: boolean;
  showDiffStats: boolean;
  useTrigramIndex: boolean;
}

const DEFAULT_SETTINGS: MigrationsSettings = {
  createPatchFiles: false,
  patchFolder: "migrations-patches",
  showLineNumbers: true,
  showDiffStats: false,
  useTrigramIndex: true,
};

interface MigrationMatch {
  file: TFile;
  originalContent: string;
  newContent: string;
  matchCount: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Helper to check if a file is an indexable markdown file */
function isMarkdownFile(file: unknown): file is TFile {
  return file instanceof TFile && file.extension === "md";
}

class TrigramIndex {
  // trigram (lowercase) -> Set<file path>
  private index: Map<string, Set<string>> = new Map();
  // file path -> Set<trigrams> (for efficient removal)
  private fileToTrigrams: Map<string, Set<string>> = new Map();

  private extractTrigrams(text: string): Set<string> {
    const trigrams = new Set<string>();
    const normalized = text.toLowerCase();
    for (let i = 0; i <= normalized.length - 3; i++) {
      trigrams.add(normalized.substring(i, i + 3));
    }
    return trigrams;
  }

  addFile(path: string, content: string): void {
    // Remove old entry if exists
    this.removeFile(path);

    const trigrams = this.extractTrigrams(content);
    this.fileToTrigrams.set(path, trigrams);

    for (const trigram of trigrams) {
      if (!this.index.has(trigram)) {
        this.index.set(trigram, new Set());
      }
      this.index.get(trigram)!.add(path);
    }
  }

  removeFile(path: string): void {
    const trigrams = this.fileToTrigrams.get(path);
    if (!trigrams) return;

    for (const trigram of trigrams) {
      const files = this.index.get(trigram);
      if (files) {
        files.delete(path);
        if (files.size === 0) {
          this.index.delete(trigram);
        }
      }
    }
    this.fileToTrigrams.delete(path);
  }

  updateFile(path: string, content: string): void {
    this.addFile(path, content);
  }

  extractLiterals(pattern: string, isRegex: boolean): string[] {
    if (!isRegex) {
      return [pattern];
    }

    // Extract consecutive literal characters from regex
    const literals: string[] = [];
    let current = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      // Skip escape sequences but capture the literal if it's an escaped special char
      if (char === "\\") {
        if (i + 1 < pattern.length) {
          const next = pattern[i + 1];
          // Common escaped literals
          if (/[.*+?^${}()|[\]\\\/]/.test(next)) {
            current += next;
            i += 2;
            continue;
          }
          // Skip other escape sequences like \d, \w, \s
          if (current.length >= 3) {
            literals.push(current);
          }
          current = "";
          i += 2;
          continue;
        }
      }

      // Skip special regex characters
      if (/[.*+?^${}()|[\]]/.test(char)) {
        if (current.length >= 3) {
          literals.push(current);
        }
        current = "";
        i++;
        continue;
      }

      current += char;
      i++;
    }

    if (current.length >= 3) {
      literals.push(current);
    }

    return literals;
  }

  getCandidates(pattern: string, isRegex: boolean): Set<string> | null {
    const literals = this.extractLiterals(pattern, isRegex);

    if (literals.length === 0) {
      // No usable literals, must scan all files
      return null;
    }

    // Collect trigrams from all literals
    const allTrigrams: string[] = [];
    for (const literal of literals) {
      const trigrams = this.extractTrigrams(literal);
      allTrigrams.push(...trigrams);
    }

    if (allTrigrams.length === 0) {
      // Pattern too short for trigrams
      return null;
    }

    // Intersect file sets for all trigrams
    let candidates: Set<string> | null = null;

    for (const trigram of allTrigrams) {
      const files = this.index.get(trigram);
      if (!files || files.size === 0) {
        // If any trigram has no matches, result is empty
        return new Set();
      }

      if (candidates === null) {
        candidates = new Set(files);
      } else {
        // Intersect
        for (const path of candidates) {
          if (!files.has(path)) {
            candidates.delete(path);
          }
        }
      }

      if (candidates.size === 0) {
        return new Set();
      }
    }

    return candidates;
  }

  getStats(): { fileCount: number; trigramCount: number } {
    return {
      fileCount: this.fileToTrigrams.size,
      trigramCount: this.index.size,
    };
  }

  addFileWithTrigrams(path: string, trigrams: Set<string>): void {
    this.removeFile(path);
    this.fileToTrigrams.set(path, trigrams);
    for (const trigram of trigrams) {
      if (!this.index.has(trigram)) {
        this.index.set(trigram, new Set());
      }
      this.index.get(trigram)!.add(path);
    }
  }

  getFileTrigrams(path: string): Set<string> | undefined {
    return this.fileToTrigrams.get(path);
  }

  static packTrigrams(trigrams: Set<string>): string {
    return [...trigrams].join("");
  }

  static unpackTrigrams(packed: string): Set<string> {
    const trigrams = new Set<string>();
    for (let i = 0; i <= packed.length - 3; i += 3) {
      trigrams.add(packed.substring(i, i + 3));
    }
    return trigrams;
  }

  clear(): void {
    this.index.clear();
    this.fileToTrigrams.clear();
  }
}

class MigrationModal extends Modal {
  private searchInput = "";
  private replaceInput = "";
  private useRegex = true;
  private caseSensitive = false;
  private multiline = false;
  private yamlOnly = false;
  private matches: MigrationMatch[] = [];
  private previewEl: HTMLElement;
  private statsEl: HTMLElement;
  private submitBtn: HTMLButtonElement;
  private searchGeneration = 0;
  private renderedCount = 0;
  private loadMoreEl: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private settings: MigrationsSettings;
  private plugin: MigrationsPlugin;

  constructor(app: App, plugin: MigrationsPlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("migrations-modal");

    this.setTitle("Replace");

    // Search input
    new Setting(contentEl)
      .setName("Find")
      .setDesc("Pattern to search for")
      .addText((text) => {
        text.inputEl.addClass("migrations-input");
        text.setPlaceholder("Enter search pattern...");
        text.onChange((value) => {
          this.searchInput = value;
          this.debouncedSearch();
        });
      });

    // Replace input
    new Setting(contentEl)
      .setName("Replace")
      .setDesc("Replacement text (use $1, $2 for regex groups)")
      .addText((text) => {
        text.inputEl.addClass("migrations-input");
        text.setPlaceholder("Enter replacement...");
        text.onChange((value) => {
          this.replaceInput = value;
          this.debouncedSearch();
        });
      });

    // Options row
    const optionsContainer = contentEl.createDiv("migrations-options");

    new Setting(optionsContainer)
      .setName("Regex")
      .addToggle((toggle: ToggleComponent) => {
        toggle.setValue(this.useRegex);
        toggle.onChange((value) => {
          this.useRegex = value;
          this.debouncedSearch();
        });
      });

    new Setting(optionsContainer)
      .setName("Case sensitive")
      .addToggle((toggle: ToggleComponent) => {
        toggle.setValue(this.caseSensitive);
        toggle.onChange((value) => {
          this.caseSensitive = value;
          this.debouncedSearch();
        });
      });

    new Setting(optionsContainer)
      .setName("Multiline")
      .addToggle((toggle: ToggleComponent) => {
        toggle.setValue(this.multiline);
        toggle.onChange((value) => {
          this.multiline = value;
          this.debouncedSearch();
        });
      });

    new Setting(optionsContainer)
      .setName("YAML only")
      .addToggle((toggle: ToggleComponent) => {
        toggle.setValue(this.yamlOnly);
        toggle.onChange((value) => {
          this.yamlOnly = value;
          this.debouncedSearch();
        });
      });

    // Stats display
    this.statsEl = contentEl.createDiv("migrations-stats");
    this.statsEl.setText("Enter a search pattern to preview changes");

    // Preview container
    this.previewEl = contentEl.createDiv("migrations-preview");

    // Submit button
    const buttonContainer = contentEl.createDiv("migrations-buttons");
    this.submitBtn = buttonContainer.createEl("button", {
      text: "Apply Changes",
      cls: "mod-cta migrations-submit",
    });
    this.submitBtn.disabled = true;
    this.submitBtn.addEventListener("click", () => this.applyChanges());

    const cancelBtn = buttonContainer.createEl("button", {
      text: "Cancel",
      cls: "migrations-cancel",
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  private debouncedSearch = debounce(() => this.performSearch(), 300, true);

  private async performSearch() {
    if (!this.searchInput.trim()) {
      this.searchGeneration++;
      this.statsEl.setText("Enter a search pattern to preview changes");
      this.previewEl.empty();
      this.matches = [];
      this.submitBtn.disabled = true;
      return;
    }

    const generation = ++this.searchGeneration;

    if (this.plugin.settings.useTrigramIndex && !this.plugin.isIndexReady()) {
      this.statsEl.setText("Building search index...");
      await this.plugin.ensureIndex();
      if (generation !== this.searchGeneration) return;
    }

    this.statsEl.setText("Searching...");

    try {
      let searchRegex: RegExp;
      let replacementText: string;

      try {
        let flags = "g";
        if (!this.caseSensitive) flags += "i";
        if (this.multiline) flags += "s";

        searchRegex = this.useRegex
          ? new RegExp(this.searchInput, flags)
          : new RegExp(this.escapeRegex(this.searchInput), flags);

        replacementText = this.processEscapeSequences(this.replaceInput);
        if (!this.useRegex) {
          replacementText = this.escapeReplacement(replacementText);
        }
      } catch (e) {
        if (generation !== this.searchGeneration) return;
        this.statsEl.setText(`Invalid regex: ${(e as Error).message}`);
        this.previewEl.empty();
        this.matches = [];
        this.submitBtn.disabled = true;
        return;
      }

      const searchStart = performance.now();
      let files = this.app.vault.getMarkdownFiles();
      const totalFiles = files.length;
      const matches: MigrationMatch[] = [];
      let totalMatches = 0;

      if (this.plugin.isIndexReady()) {
        const trigramStart = performance.now();
        const candidates = this.plugin.trigramIndex.getCandidates(this.searchInput, this.useRegex);
        if (candidates !== null) {
          const candidateSet = candidates;
          files = files.filter((f) => candidateSet.has(f.path));
        }
        const trigramTime = (performance.now() - trigramStart).toFixed(2);
        debug(`Migrations: Trigram filter: ${totalFiles} → ${files.length} files in ${trigramTime}ms`);
      }

      for (let i = 0; i < files.length; i++) {
        if (generation !== this.searchGeneration) return;

        const file = files[i];
        let content: string;
        try {
          content = await this.app.vault.cachedRead(file);
        } catch (e) {
          debug(`Migrations: Failed to read ${file.path}:`, e);
          continue;
        }

        let newContent: string;
        let matchCount: number;

        if (this.yamlOnly) {
          const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!yamlMatch) continue;

          const yamlContent = yamlMatch[1];
          matchCount = (yamlContent.match(searchRegex) || []).length;
          if (matchCount === 0) continue;

          const newYaml = yamlContent.replace(searchRegex, replacementText);
          newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newYaml}\n---`);
        } else {
          matchCount = (content.match(searchRegex) || []).length;
          if (matchCount === 0) continue;

          newContent = content.replace(searchRegex, replacementText);
        }

        totalMatches += matchCount;
        matches.push({
          file,
          originalContent: content,
          newContent,
          matchCount,
          linesAdded: 0,
          linesRemoved: 0,
        });

        if (i % 100 === 99) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      if (generation !== this.searchGeneration) return;

      this.matches = matches;

      // Compute diff stats lazily -- only when the setting is on
      if (this.settings.showDiffStats) {
        for (const match of this.matches) {
          const { added, removed } = this.calculateLineDiff(match.originalContent, match.newContent);
          match.linesAdded = added;
          match.linesRemoved = removed;
        }
      }

      const searchTime = (performance.now() - searchStart).toFixed(2);
      debug(`Migrations: Search complete: ${this.matches.length} matches in ${files.length}/${totalFiles} files, took ${searchTime}ms`);

      this.updateStats(totalMatches);
      this.renderPreview();
      this.submitBtn.disabled = this.matches.length === 0;
    } catch (e) {
      if (generation !== this.searchGeneration) return;
      this.statsEl.setText(`Search error: ${(e as Error).message}`);
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Escape $ in replacement text for non-regex mode to prevent special pattern interpretation */
  private escapeReplacement(str: string): string {
    return str.replace(/\$/g, "$$$$");
  }

  /** Process escape sequences like \n and \t in replacement text */
  private processEscapeSequences(str: string): string {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\\\/g, "\\");
  }

  private calculateLineDiff(original: string, modified: string): { added: number; removed: number } {
    const changes = diffLines(original, modified);
    let added = 0;
    let removed = 0;
    for (const change of changes) {
      const lineCount = change.value.split("\n").filter((l) => l !== "").length;
      if (change.added) added += lineCount;
      else if (change.removed) removed += lineCount;
    }
    return { added, removed };
  }

  private updateStats(totalMatches: number) {
    const fileCount = this.matches.length;
    if (fileCount === 0) {
      this.statsEl.setText("No matches found");
      return;
    }

    let statsText = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}`;

    if (this.settings.showDiffStats) {
      const totalAdded = this.matches.reduce((sum, m) => sum + m.linesAdded, 0);
      const totalRemoved = this.matches.reduce((sum, m) => sum + m.linesRemoved, 0);
      statsText += ` | `;

      this.statsEl.empty();
      this.statsEl.createSpan({ text: statsText });
      this.statsEl.createSpan({ text: `+${totalAdded}`, cls: "migrations-stat-added" });
      this.statsEl.createSpan({ text: " / " });
      this.statsEl.createSpan({ text: `-${totalRemoved}`, cls: "migrations-stat-removed" });
    } else {
      this.statsEl.setText(statsText);
    }
  }

  private renderPreview() {
    this.previewEl.empty();
    this.renderedCount = 0;
    this.cleanupObserver();

    this.renderMoreFiles(10);
    this.setupLazyLoading();
  }

  private renderMoreFiles(count: number) {
    const start = this.renderedCount;
    const end = Math.min(start + count, this.matches.length);

    for (let i = start; i < end; i++) {
      const match = this.matches[i];
      const fileContainer = this.previewEl.createDiv("migrations-file");

      const header = fileContainer.createDiv("migrations-file-header");
      const pathEl = header.createSpan({ text: match.file.path, cls: "migrations-file-path migrations-file-link" });
      this.addFileClickHandler(pathEl, match.file);
      header.createSpan({
        text: `${match.matchCount} match${match.matchCount === 1 ? "" : "es"}`,
        cls: "migrations-match-count",
      });

      const diffContainer = fileContainer.createDiv("migrations-diff");
      this.renderDiff(diffContainer, match.originalContent, match.newContent);
    }

    this.renderedCount = end;
    this.updateLoadMoreEl();
  }

  private addFileClickHandler(el: HTMLElement, file: TFile) {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const newLeaf = e.ctrlKey || e.metaKey;
      this.openFile(file, newLeaf);
    });

    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    });

    el.addEventListener("mouseup", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.openFile(file, true);
      }
    });
  }

  private openFile(file: TFile, newLeaf: boolean) {
    const leaf = newLeaf
      ? this.app.workspace.getLeaf("tab")
      : this.app.workspace.getLeaf(false);
    leaf.openFile(file);
  }

  private updateLoadMoreEl() {
    if (this.loadMoreEl) {
      if (this.observer) this.observer.unobserve(this.loadMoreEl);
      this.loadMoreEl.remove();
      this.loadMoreEl = null;
    }

    const remaining = this.matches.length - this.renderedCount;
    if (remaining > 0) {
      this.loadMoreEl = this.previewEl.createDiv({
        text: `Scroll for ${remaining} more file${remaining === 1 ? "" : "s"}...`,
        cls: "migrations-more migrations-load-trigger",
      });
      if (this.observer) this.observer.observe(this.loadMoreEl);
    }
  }

  private setupLazyLoading() {
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && this.renderedCount < this.matches.length) {
          this.renderMoreFiles(10);
        }
      },
      { root: this.previewEl, threshold: 0.1 }
    );

    if (this.loadMoreEl) {
      this.observer.observe(this.loadMoreEl);
    }
  }

  private cleanupObserver() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private renderDiff(container: HTMLElement, original: string, modified: string) {
    const changes = diffLines(original, modified);
    const contextLines = 2;
    const showLineNums = this.settings.showLineNumbers;
    let oldLineNum = 1;
    let newLineNum = 1;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      // Use a more robust split that doesn't create artifacts
      const lines = change.value.split(/\r?\n/);
      if (lines[lines.length - 1] === "") lines.pop();

      if (change.added || change.removed) {
          const nextChange = changes[i + 1];
          const isPair = change.removed && nextChange?.added;

          if (isPair) {
              const removedLines = lines;
              const addedLines = nextChange.value.split(/\r?\n/);
              if (addedLines[addedLines.length - 1] === "") addedLines.pop();
              
              const maxLines = Math.max(removedLines.length, addedLines.length);

              for (let j = 0; j < maxLines; j++) {
                  const oldL = removedLines[j];
                  const newL = addedLines[j];

                  if (oldL !== undefined) {
                      this.renderInlineDiffLine(container, oldL, newL, oldLineNum++, false, showLineNums);
                  }
                  if (newL !== undefined) {
                      this.renderInlineDiffLine(container, oldL, newL, newLineNum++, true, showLineNums);
                  }
              }
              i++; 
          } else {
              for (const line of lines) {
                  if (change.added) {
                      this.renderInlineDiffLine(container, undefined, line, newLineNum++, true, showLineNums);
                  } else {
                      this.renderInlineDiffLine(container, line, undefined, oldLineNum++, false, showLineNums);
                  }
              }
          }
      } else {
        const prevIsChange = i > 0 && (changes[i - 1].added || changes[i - 1].removed);
        const nextIsChange = i < changes.length - 1 && (changes[i + 1].added || changes[i + 1].removed);

        if (!prevIsChange && !nextIsChange) {
          oldLineNum += lines.length;
          newLineNum += lines.length;
          continue;
        }

        let showLines: { line: string; lineNum: number }[] = [];
        if (prevIsChange && nextIsChange) {
          if (lines.length <= contextLines * 2) {
            showLines = lines.map((l, idx) => ({ line: l, lineNum: oldLineNum + idx }));
          } else {
            const head = lines.slice(0, contextLines).map((l, idx) => ({ line: l, lineNum: oldLineNum + idx }));
            const tail = lines.slice(-contextLines).map((l, idx) => ({ line: l, lineNum: oldLineNum + lines.length - contextLines + idx }));
            showLines = [...head, { line: "...", lineNum: -1 }, ...tail];
          }
        } else if (prevIsChange) {
          showLines = lines.slice(0, contextLines).map((l, idx) => ({ line: l, lineNum: oldLineNum + idx }));
        } else {
          const startIdx = lines.length - contextLines;
          showLines = lines.slice(-contextLines).map((l, idx) => ({ line: l, lineNum: oldLineNum + startIdx + idx }));
        }

        for (const { line, lineNum } of showLines) {
          const lineEl = container.createDiv("migrations-diff-line migrations-diff-context");
          if (line === "...") {
            lineEl.setText(showLineNums ? "     ..." : "  ...");
          } else {
            const prefix = showLineNums ? `${String(lineNum).padStart(4)}   ` : "  ";
            lineEl.setText(prefix + line);
          }
        }

        oldLineNum += lines.length;
        newLineNum += lines.length;
      }
    }
  }

  private renderInlineDiffLine(
    container: HTMLElement,
    oldLine: string | undefined,
    newLine: string | undefined,
    lineNum: number,
    isAdded: boolean,
    showLineNums: boolean
) {
    const lineEl = container.createDiv("migrations-diff-line");
    lineEl.addClass(isAdded ? "migrations-diff-added" : "migrations-diff-removed");

    if (showLineNums) {
        lineEl.createSpan({ text: `${String(lineNum).padStart(4)} `, cls: "migrations-line-num" });
    }
    lineEl.createSpan({ text: isAdded ? "+ " : "- " });

    // If we have both lines, perform word-level diff
    if (oldLine !== undefined && newLine !== undefined) {
        const wordChanges = diffWords(oldLine, newLine);
        
        for (const part of wordChanges) {
            if (isAdded) {
                // For the green line: show new stuff and unchanged stuff
                if (part.added) {
                    lineEl.createSpan({ text: part.value, cls: "migrations-inline-highlight" });
                } else if (!part.removed) {
                    lineEl.createSpan({ text: part.value });
                }
            } else {
                // For the red line: show old stuff and unchanged stuff
                if (part.removed) {
                    lineEl.createSpan({ text: part.value, cls: "migrations-inline-highlight" });
                } else if (!part.added) {
                    lineEl.createSpan({ text: part.value });
                }
            }
        }
    } else {
        // Fallback: no pair exists, just show the literal line content
        const content = isAdded ? newLine : oldLine;
        lineEl.createSpan({ text: content || "" });
    }
}

  private async applyChanges() {
    if (this.matches.length === 0) return;

    const confirmed = await this.confirmChanges();
    if (!confirmed) return;

    this.submitBtn.disabled = true;
    this.submitBtn.setText("Applying...");

    if (this.settings.createPatchFiles) {
      await this.createPatchFiles();
    }

    let successCount = 0;
    let errorCount = 0;

    for (const match of this.matches) {
      try {
        await this.app.vault.modify(match.file, match.newContent);
        successCount++;
      } catch (e) {
        console.error(`Failed to update ${match.file.path}:`, e);
        errorCount++;
      }
    }

    this.close();

    if (errorCount === 0) {
      new Notice(`Successfully updated ${successCount} files`);
    } else {
      new Notice(
        `Updated ${successCount} files, ${errorCount} failed. Check console for details.`
      );
    }
  }

  private async createPatchFiles() {
    const folder = this.settings.patchFolder;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    try {
      // Ensure folder exists
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }

      let patchContent = `Migration patch created at ${timestamp}\n`;
      patchContent += `Search: ${this.searchInput}\n`;
      patchContent += `Replace: ${this.replaceInput}\n`;
      patchContent += `Files affected: ${this.matches.length}\n\n`;

      for (const match of this.matches) {
        patchContent += `--- ${match.file.path}\n`;
        patchContent += `+++ ${match.file.path}\n`;
        const changes = diffLines(match.originalContent, match.newContent);
        for (const change of changes) {
          if (change.added || change.removed) {
            const prefix = change.added ? "+" : "-";
            const lines = change.value.split("\n");
            for (const line of lines) {
              if (line) patchContent += `${prefix}${line}\n`;
            }
          }
        }
        patchContent += "\n";
      }

      const patchPath = `${folder}/migration-${timestamp}.patch`;
      await this.app.vault.create(patchPath, patchContent);
    } catch (e) {
      console.error("Migrations: Failed to create patch file:", e);
      new Notice("Failed to create patch file. Check console for details.");
    }
  }

  private async confirmChanges(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(
        this.app,
        this.matches.length,
        (confirmed) => resolve(confirmed)
      );
      modal.open();
    });
  }

  onClose() {
    this.cleanupObserver();
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  private fileCount: number;
  private onConfirm: (confirmed: boolean) => void;

  constructor(
    app: App,
    fileCount: number,
    onConfirm: (confirmed: boolean) => void
  ) {
    super(app);
    this.fileCount = fileCount;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle("Confirm Changes");

    contentEl.createEl("p", {
      text: `You are about to modify ${this.fileCount} file${this.fileCount === 1 ? "" : "s"}. This action cannot be undone.`,
    });

    const buttonContainer = contentEl.createDiv("migrations-confirm-buttons");

    const confirmBtn = buttonContainer.createEl("button", {
      text: "Apply Changes",
      cls: "mod-warning",
    });
    confirmBtn.addEventListener("click", () => {
      this.onConfirm(true);
      this.close();
    });

    const cancelBtn = buttonContainer.createEl("button", {
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => {
      this.onConfirm(false);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export default class MigrationsPlugin extends Plugin {
  settings: MigrationsSettings;
  trigramIndex: TrigramIndex = new TrigramIndex();
  private indexReady = false;
  private indexPromise: Promise<void> | null = null;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "open-migration-modal",
      name: "Replace",
      callback: () => {
        new MigrationModal(this.app, this).open();
      },
    });

    this.addSettingTab(new MigrationsSettingTab(this.app, this));

    if (this.settings.useTrigramIndex) {
      this.registerVaultEvents();
    }
  }

  async ensureIndex(): Promise<void> {
    if (this.indexReady) return;
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex();
    }
    return this.indexPromise;
  }

  private async buildIndex() {
    const startTime = performance.now();
    const files = this.app.vault.getMarkdownFiles();
    let errorCount = 0;
    let cacheHits = 0;

    const cache = await this.loadTrigramCache();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const cached = cache?.[file.path];

      if (cached && cached[0] === file.stat.mtime) {
        const trigrams = TrigramIndex.unpackTrigrams(cached[1]);
        this.trigramIndex.addFileWithTrigrams(file.path, trigrams);
        cacheHits++;
      } else {
        try {
          const content = await this.app.vault.cachedRead(file);
          this.trigramIndex.addFile(file.path, content);
        } catch (e) {
          errorCount++;
          debug(`Migrations: Failed to index ${file.path}:`, e);
        }
      }

      if (i % 50 === 49) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    this.indexReady = true;
    await this.saveTrigramCache(files);

    const elapsed = (performance.now() - startTime).toFixed(1);
    const stats = this.trigramIndex.getStats();
    debug(`Migrations: Indexed ${stats.fileCount} files (${stats.trigramCount} trigrams) in ${elapsed}ms, ${cacheHits} cache hits${errorCount > 0 ? `, ${errorCount} errors` : ""}`);
  }

  private async loadTrigramCache(): Promise<Record<string, [number, string]> | null> {
    try {
      const raw = await this.app.vault.adapter.read(
        `${this.manifest.dir}/trigram-cache.json`
      );
      const cache = JSON.parse(raw);
      if (cache?.v !== 1) return null;
      return cache.files;
    } catch {
      return null;
    }
  }

  private async saveTrigramCache(files: TFile[]) {
    try {
      const entries: Record<string, [number, string]> = {};
      for (const file of files) {
        const trigrams = this.trigramIndex.getFileTrigrams(file.path);
        if (trigrams) {
          entries[file.path] = [file.stat.mtime, TrigramIndex.packTrigrams(trigrams)];
        }
      }
      await this.app.vault.adapter.write(
        `${this.manifest.dir}/trigram-cache.json`,
        JSON.stringify({ v: 1, files: entries })
      );
    } catch (e) {
      debug("Migrations: Failed to save trigram cache:", e);
    }
  }

  private registerVaultEvents() {
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!this.indexReady) return;
        if (isMarkdownFile(file)) {
          try {
            const content = await this.app.vault.cachedRead(file);
            this.trigramIndex.updateFile(file.path, content);
          } catch (e) {
            debug(`Migrations: Failed to update index for ${file.path}:`, e);
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (!this.indexReady) return;
        if (isMarkdownFile(file)) {
          try {
            const content = await this.app.vault.cachedRead(file);
            this.trigramIndex.addFile(file.path, content);
          } catch (e) {
            debug(`Migrations: Failed to index new file ${file.path}:`, e);
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.indexReady) return;
        if (isMarkdownFile(file)) {
          this.trigramIndex.removeFile(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!this.indexReady) return;
        if (isMarkdownFile(file)) {
          this.trigramIndex.removeFile(oldPath);
          try {
            const content = await this.app.vault.cachedRead(file);
            this.trigramIndex.addFile(file.path, content);
          } catch (e) {
            debug(`Migrations: Failed to index renamed file ${file.path}:`, e);
          }
        }
      })
    );
  }

  isIndexReady(): boolean {
    return this.settings.useTrigramIndex && this.indexReady;
  }

  onunload() {
    this.trigramIndex.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class MigrationsSettingTab extends PluginSettingTab {
  plugin: MigrationsPlugin;

  constructor(app: App, plugin: MigrationsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Migrations Settings" });

    new Setting(containerEl)
      .setName("Show line numbers")
      .setDesc("Display line numbers in the diff preview")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showLineNumbers)
          .onChange(async (value) => {
            this.plugin.settings.showLineNumbers = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show diff statistics")
      .setDesc("Display +/- line count in the stats bar")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDiffStats)
          .onChange(async (value) => {
            this.plugin.settings.showDiffStats = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Create patch files")
      .setDesc("Save .patch files before applying changes")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createPatchFiles)
          .onChange(async (value) => {
            this.plugin.settings.createPatchFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Patch folder")
      .setDesc("Folder to store patch files")
      .addText((text) =>
        text
          .setPlaceholder("migrations-patches")
          .setValue(this.plugin.settings.patchFolder)
          .onChange(async (value) => {
            this.plugin.settings.patchFolder = value || "migrations-patches";
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Performance" });

    const stats = this.plugin.trigramIndex.getStats();
    const indexDesc = this.plugin.isIndexReady()
      ? `Pre-filter files using trigram index for faster search. Currently indexing ${stats.fileCount} files (${stats.trigramCount} trigrams).`
      : "Pre-filter files using trigram index for faster search. Index is built on first use.";

    new Setting(containerEl)
      .setName("Use trigram index")
      .setDesc(indexDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useTrigramIndex)
          .onChange(async (value) => {
            this.plugin.settings.useTrigramIndex = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
