import { chromium, Browser, Page } from 'playwright';
import { AudioAnalyzer } from './AudioAnalyzer.js';

export class StrudelController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private analyzer: AudioAnalyzer;
  private isHeadless: boolean;
  private consoleErrors: string[] = [];

  constructor(headless: boolean = false) {
    this.isHeadless = headless;
    this.analyzer = new AudioAnalyzer();
  }

  async initialize(): Promise<string> {
    if (this.browser) {
      return 'Already initialized';
    }

    this.browser = await chromium.launch({
      headless: this.isHeadless,
      args: ['--use-fake-ui-for-media-stream'],
    });

    const context = await this.browser.newContext({
      permissions: ['microphone'],
    });

    this.page = await context.newPage();

    // Listen for console errors from Strudel
    this.page.on('console', (msg) => {
      const text = msg.text();
      // Capture [getTrigger] errors and [eval] errors
      if (text.includes('[getTrigger] error') || text.includes('[eval] error')) {
        this.consoleErrors.push(text);
      }
    });

    await this.page.goto('https://strudel.cc/', {
      waitUntil: 'networkidle',
    });

    await this.page.waitForSelector('.cm-content', { timeout: 10000 });

    await this.analyzer.inject(this.page);

    return 'Strudel initialized successfully';
  }

  async writePattern(pattern: string): Promise<string> {
    if (!this.page) throw new Error('Not initialized');

    // Use page.evaluate to directly set the editor content
    // This properly handles multiline code, unlike keyboard.type()
    await this.page.evaluate((code) => {
      const editor = document.querySelector('.cm-content') as any;
      if (editor) {
        const view = editor.cmView?.view;
        if (view) {
          // Use CodeMirror's API to replace all content
          const transaction = view.state.update({
            changes: { from: 0, to: view.state.doc.length, insert: code }
          });
          view.dispatch(transaction);
        } else {
          // Fallback: set textContent directly
          editor.textContent = code;
        }
      }
    }, pattern);

    return `Pattern written (${pattern.length} chars)`;
  }

  async getCurrentPattern(): Promise<string> {
    if (!this.page) throw new Error('Not initialized');

    return await this.page.evaluate(() => {
      const editor = document.querySelector('.cm-content');
      return editor?.textContent || '';
    });
  }

  async play(): Promise<string> {
    if (!this.page) throw new Error('Not initialized');

    try {
      await this.page.click('button[title*="play" i]', { timeout: 1000 });
    } catch {
      await this.page.keyboard.press('ControlOrMeta+Enter');
    }

    await this.page.waitForTimeout(500);

    return 'Playing';
  }

  async stop(): Promise<string> {
    if (!this.page) throw new Error('Not initialized');

    try {
      await this.page.click('button[title*="stop" i]', { timeout: 1000 });
    } catch {
      await this.page.keyboard.press('ControlOrMeta+Period');
    }

    return 'Stopped';
  }

  async update(pattern: string): Promise<string> {
    if (!this.page) throw new Error('Not initialized');

    // Clear previous errors
    this.consoleErrors = [];

    await this.writePattern(pattern);
    await this.page.waitForTimeout(100);

    try {
      await this.page.click('button[title*="update" i]', { timeout: 1000 });
    } catch {
      await this.page.keyboard.press('ControlOrMeta+Enter');
    }

    await this.page.waitForTimeout(1000); // Wait longer for errors to appear

    // Check for errors
    if (this.consoleErrors.length > 0) {
      const uniqueErrors = [...new Set(this.consoleErrors)];
      return `Updated and playing\n\n⚠️ ERRORS DETECTED:\n${uniqueErrors.join('\n')}`;
    }

    return 'Updated and playing';
  }

  getConsoleErrors(): string[] {
    return this.consoleErrors;
  }

  clearConsoleErrors(): void {
    this.consoleErrors = [];
  }

  async analyzeAudio(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.analyzer.getAnalysis(this.page);
  }

  async getSounds(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.page.evaluate(() => {
      const win = window as any;

      try {
        // Access soundMap reactive object's value property
        if (win.soundMap && win.soundMap.value) {
          const soundsObj = win.soundMap.value;
          return Object.keys(soundsObj).sort();
        }

        return [];
      } catch (e) {
        return { error: String(e) };
      }
    });
  }

  async listAvailableSounds(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.page.evaluate(() => {
      const win = window as any;

      try {
        // Access soundMap reactive object's value property
        if (win.soundMap && win.soundMap.value) {
          const soundsObj = win.soundMap.value;
          const soundList = Object.keys(soundsObj).sort();

          return {
            total: soundList.length,
            sounds: soundList
          };
        }

        return {
          total: 0,
          sounds: [],
          error: 'soundMap.value not found'
        };
      } catch (e) {
        return {
          total: 0,
          sounds: [],
          error: String(e)
        };
      }
    });
  }

  async getSoundCategories(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.page.evaluate(() => {
      const categories: any = {
        synths: [],
        zzfx: [],
        casio: [],
        other: []
      };

      try {
        const win = window as any;

        // Get all available sounds from soundMap
        if (win.soundMap && win.soundMap.value) {
          const soundsObj = win.soundMap.value;
          const allSounds = Object.keys(soundsObj).sort();

          // Categorize sounds
          const synthWaveforms = ['triangle', 'square', 'sawtooth', 'sine', 'tri', 'sqr', 'saw', 'sin', 'sbd', 'supersaw', 'pulse'];
          const noiseGenerators = ['pink', 'white', 'brown', 'crackle'];
          const zzfxSounds = ['zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise'];
          const casioSounds = ['casio', 'crow', 'insect', 'wind', 'jazz', 'metal', 'east'];
          const otherSynths = ['bytebeat'];

          allSounds.forEach((sound: string) => {
            if (synthWaveforms.includes(sound) || noiseGenerators.includes(sound) || otherSynths.includes(sound)) {
              categories.synths.push(sound);
            } else if (zzfxSounds.includes(sound)) {
              categories.zzfx.push(sound);
            } else if (casioSounds.includes(sound)) {
              categories.casio.push(sound);
            } else {
              categories.other.push(sound);
            }
          });
        }

      } catch (e) {
        categories.error = String(e);
      }

      return categories;
    });
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
