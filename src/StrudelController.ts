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
      const type = msg.type();
      // Capture all errors and warnings
      if (type === 'error' || type === 'warning' ||
          text.includes('[getTrigger] error') ||
          text.includes('[eval] error') ||
          text.includes('[query]')) {
        this.consoleErrors.push(`[${type}] ${text}`);
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

    // Use CodeMirror API to get full document content instead of textContent
    // textContent can truncate long patterns
    return await this.page.evaluate(() => {
      const editor = document.querySelector('.cm-content') as any;
      if (editor && editor.cmView?.view) {
        // Get full document from CodeMirror state
        return editor.cmView.view.state.doc.toString();
      }
      // Fallback to textContent if CodeMirror API not available
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

  async startRecording(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.analyzer.startRecording(this.page);
  }

  async stopRecording(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.analyzer.stopRecording(this.page);
  }

  async recordTimed(durationSeconds: number): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    const startResult = await this.analyzer.startRecording(this.page);
    if (!startResult.success) {
      return startResult;
    }

    // Wait for the specified duration
    await this.page.waitForTimeout(durationSeconds * 1000);

    return await this.analyzer.stopRecording(this.page);
  }

  async calculatePatternDuration(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    return await this.page.evaluate(() => {
      try {
        const editor = document.querySelector('.cm-content');
        const patternCode = editor?.textContent || '';

        // Extract CPM value
        const cpmMatch = patternCode.match(/setcpm\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);
        const cpm = cpmMatch ? parseFloat(cpmMatch[1]) : 60;

        // Find the longest .slow() value in masks
        const slowMatches = patternCode.matchAll(/\.slow\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g);
        let maxSlowValue = 1;
        for (const match of slowMatches) {
          const slowValue = parseFloat(match[1]);
          if (slowValue > maxSlowValue) {
            maxSlowValue = slowValue;
          }
        }

        // Calculate duration: (cycles / CPM) * 60 seconds
        const durationSeconds = (maxSlowValue / cpm) * 60;

        return {
          success: true,
          cpm: cpm,
          cycles: maxSlowValue,
          durationSeconds: Math.round(durationSeconds * 100) / 100,
          durationFormatted: `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, '0')}`
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    });
  }

  async recordFullPattern(): Promise<any> {
    if (!this.page) throw new Error('Not initialized');

    // Calculate pattern duration
    const durationInfo = await this.calculatePatternDuration();
    if (!durationInfo.success) {
      return {
        error: 'Failed to calculate pattern duration: ' + durationInfo.error
      };
    }

    // Stop current playback
    await this.stop();

    // Start fresh from beginning
    await this.play();

    // Wait a moment for audio to stabilize
    await this.page.waitForTimeout(500);

    // Start recording
    const startResult = await this.analyzer.startRecording(this.page);
    if (!startResult.success) {
      return startResult;
    }

    // Wait for full pattern duration
    await this.page.waitForTimeout(durationInfo.durationSeconds * 1000);

    // Stop recording
    const result = await this.analyzer.stopRecording(this.page);

    // Add duration info to result
    if (result.success) {
      result.patternInfo = {
        cpm: durationInfo.cpm,
        cycles: durationInfo.cycles,
        expectedDuration: durationInfo.durationSeconds,
        durationFormatted: durationInfo.durationFormatted
      };
    }

    return result;
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
