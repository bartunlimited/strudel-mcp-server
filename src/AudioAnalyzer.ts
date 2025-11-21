import { Page } from 'playwright';

export class AudioAnalyzer {
  async inject(page: Page) {
    await page.evaluate(() => {
      (window as any).strudelAudioAnalyzer = {
        analyser: null as AnalyserNode | null,
        dataArray: null as Uint8Array | null,
        isConnected: false,
        lastConnectionTime: 0,
        sourceNode: null as AudioNode | null,  // Store reference to source node

        // Audio recording
        mediaRecorder: null as MediaRecorder | null,
        audioChunks: [] as Blob[],
        isRecording: false,
        recordingStartTime: 0,
        recordingDestination: null as MediaStreamAudioDestinationNode | null,

        connect() {
          const originalConnect = AudioNode.prototype.connect;

          (AudioNode.prototype as any).connect = function(this: AudioNode, ...args: any[]) {
            const nodeType = this.constructor.name;
            const destType = args[0] ? args[0].constructor.name : 'undefined';
            const isDestination = destType === 'AudioDestinationNode';

            console.log('[AudioAnalyzer] Connection:', {
              from: nodeType,
              to: destType,
              isDestination: isDestination
            });

            if (isDestination) {
              const ctx = (this as any).context as AudioContext;
              const destination = args[0];

              if (!(window as any).strudelAudioAnalyzer.analyser ||
                  (window as any).strudelAudioAnalyzer.analyser.context !== ctx) {
                (window as any).strudelAudioAnalyzer.analyser = ctx.createAnalyser();
                (window as any).strudelAudioAnalyzer.analyser.fftSize = 2048;
                (window as any).strudelAudioAnalyzer.dataArray = new Uint8Array(
                  (window as any).strudelAudioAnalyzer.analyser.frequencyBinCount
                );
                console.log('[AudioAnalyzer] Created analyser node in context:', ctx);
              }

              // Store reference to source node for recording
              (window as any).strudelAudioAnalyzer.sourceNode = this;

              const result = originalConnect.call(this, (window as any).strudelAudioAnalyzer.analyser);
              originalConnect.call((window as any).strudelAudioAnalyzer.analyser, destination);
              (window as any).strudelAudioAnalyzer.isConnected = true;
              (window as any).strudelAudioAnalyzer.lastConnectionTime = Date.now();
              console.log('[AudioAnalyzer] Inserted analyser:', nodeType, '-> Analyser -> Destination');
              return result;
            }

            return (originalConnect as any).apply(this, args);
          };
        },
        
        analyze() {
          if (!this.analyser || !this.isConnected) {
            return {
              connected: false,
              error: 'Analyzer not connected'
            };
          }

          this.analyser.getByteFrequencyData(this.dataArray);
          const data: number[] = Array.from(this.dataArray);

          const sum = data.reduce((a, b) => a + b, 0);
          const average = sum / data.length;

          const bass = data.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
          const lowMid = data.slice(8, 32).reduce((a, b) => a + b, 0) / 24;
          const mid = data.slice(32, 128).reduce((a, b) => a + b, 0) / 96;
          const highMid = data.slice(128, 256).reduce((a, b) => a + b, 0) / 128;
          const treble = data.slice(256, 512).reduce((a, b) => a + b, 0) / 256;

          const peak = Math.max(...data);
          const peakIndex = data.indexOf(peak);
          const peakFreq = (peakIndex / data.length) * 22050;

          let weightedSum = 0;
          let magnitudeSum = 0;
          data.forEach((mag, i) => {
            weightedSum += i * mag;
            magnitudeSum += mag;
          });
          const centroid = magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;

          const isPlaying = average > 5;
          const isSilent = average < 1;
          const hasData = this.dataArray && this.dataArray.length > 0;
          const ageMs = Date.now() - this.lastConnectionTime;

          return {
            connected: true,
            connectionStatus: {
              flagged: true,
              hasData: hasData,
              ageMs: ageMs
            },
            timestamp: Date.now(),
            features: {
              average: Math.round(average * 10) / 10,
              peak,
              peakFrequency: Math.round(peakFreq),
              centroid: Math.round(centroid * 10) / 10,

              bass: Math.round(bass),
              lowMid: Math.round(lowMid),
              mid: Math.round(mid),
              highMid: Math.round(highMid),
              treble: Math.round(treble),

              isPlaying,
              isSilent,

              bassToTrebleRatio: treble > 0 ? (bass / treble).toFixed(2) : 'N/A',
              brightness: centroid > 500 ? 'bright' : centroid > 200 ? 'balanced' : 'dark'
            }
          };
        },

        startRecording() {
          if (this.isRecording) {
            return { error: 'Already recording' };
          }

          if (!this.analyser) {
            return { error: 'Analyzer not connected - play pattern first' };
          }

          if (!this.sourceNode) {
            return { error: 'Source node not available - play pattern first' };
          }

          try {
            const ctx = this.sourceNode.context as AudioContext;

            console.log('[AudioAnalyzer] Starting recording from source node:', this.sourceNode.constructor.name);
            console.log('[AudioAnalyzer] Context type:', ctx.constructor.name);
            console.log('[AudioAnalyzer] Has createMediaStreamDestination:', typeof ctx.createMediaStreamDestination);

            // Check if context supports MediaStreamDestination
            if (typeof ctx.createMediaStreamDestination !== 'function') {
              return {
                error: 'Audio context does not support MediaStreamDestination. This is a browser/context limitation.'
              };
            }

            const dest = ctx.createMediaStreamDestination();
            this.recordingDestination = dest;

            // Connect source node directly to recording destination (in addition to analyser->destination)
            this.sourceNode.connect(dest);

            this.mediaRecorder = new MediaRecorder(dest.stream, {
              mimeType: 'audio/webm;codecs=opus'
            });

            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
              if (event.data.size > 0) {
                this.audioChunks.push(event.data);
              }
            };

            this.mediaRecorder.start(100); // Collect data every 100ms
            this.isRecording = true;
            this.recordingStartTime = Date.now();

            console.log('[AudioAnalyzer] Recording started');
            return { success: true, message: 'Recording started' };
          } catch (error: any) {
            console.error('[AudioAnalyzer] Recording error:', error);
            return { error: error.message || 'Failed to start recording' };
          }
        },

        async stopRecording() {
          if (!this.isRecording || !this.mediaRecorder) {
            return { error: 'Not currently recording' };
          }

          return new Promise((resolve) => {
            this.mediaRecorder!.onstop = async () => {
              const duration = (Date.now() - this.recordingStartTime) / 1000;
              const blob = new Blob(this.audioChunks, { type: 'audio/webm' });

              // Convert blob to base64 for transfer
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64data = reader.result as string;
                const base64 = base64data.split(',')[1];

                this.isRecording = false;
                this.audioChunks = [];

                // Disconnect the recording destination
                if (this.sourceNode && this.recordingDestination) {
                  try {
                    // Only disconnect if both nodes are in the same audio context
                    if (this.sourceNode.context === this.recordingDestination.context) {
                      this.sourceNode.disconnect(this.recordingDestination);
                      console.log('[AudioAnalyzer] Disconnected recording destination');
                    } else {
                      console.log('[AudioAnalyzer] Skipping disconnect - nodes in different contexts');
                    }
                  } catch (e) {
                    console.warn('[AudioAnalyzer] Error disconnecting recording destination:', e);
                  }
                }
                this.recordingDestination = null;

                console.log('[AudioAnalyzer] Recording stopped, duration:', duration, 's');
                resolve({
                  success: true,
                  duration: Math.round(duration * 10) / 10,
                  sizeBytes: blob.size,
                  format: 'webm',
                  audioData: base64
                });
              };
              reader.readAsDataURL(blob);
            };

            this.mediaRecorder!.stop();
          });
        }
      };

      (window as any).strudelAudioAnalyzer.connect();
    });
  }

  async getAnalysis(page: Page): Promise<any> {
    return await page.evaluate(() => {
      if ((window as any).strudelAudioAnalyzer) {
        return (window as any).strudelAudioAnalyzer.analyze();
      }
      return { error: 'Analyzer not initialized' };
    });
  }

  async startRecording(page: Page): Promise<any> {
    return await page.evaluate(() => {
      if ((window as any).strudelAudioAnalyzer) {
        return (window as any).strudelAudioAnalyzer.startRecording();
      }
      return { error: 'Analyzer not initialized' };
    });
  }

  async stopRecording(page: Page): Promise<any> {
    return await page.evaluate(() => {
      if ((window as any).strudelAudioAnalyzer) {
        return (window as any).strudelAudioAnalyzer.stopRecording();
      }
      return { error: 'Analyzer not initialized' };
    });
  }
}