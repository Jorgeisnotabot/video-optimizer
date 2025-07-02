const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { promisify } = require('util');

// Configuration
const DEFAULT_CONFIG = {
    duration: 15,        // seconds
    quality: 28,         // CRF value (lower = better quality)
    maxWidth: 1920,     // max width in pixels
    maxHeight: 1080,    // max height in pixels
    framerate: 30,      // fps
    outputSuffix: '_optimized'
};

class VideoOptimizer {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async optimizeVideo(inputPath, outputPath = null) {
        try {
            // Validate input file
            if (!fs.existsSync(inputPath)) {
                throw new Error(`Input file not found: ${inputPath}`);
            }

            // Generate output path if not provided
            if (!outputPath) {
                const ext = path.extname(inputPath);
                const name = path.basename(inputPath, ext);
                const dir = path.dirname(inputPath);
                outputPath = path.join(dir, `${name}${this.config.outputSuffix}.mp4`);
            }

            console.log(`🎬 Optimizing: ${path.basename(inputPath)}`);
            console.log(`📁 Output: ${path.basename(outputPath)}`);

            // Get original file info
            const originalStats = await this.getVideoInfo(inputPath);
            console.log(`📊 Original: ${originalStats.size}MB, ${originalStats.duration}s`);

            // Build FFmpeg command
            const command = this.buildFFmpegCommand(inputPath, outputPath);
            
            // Execute FFmpeg
            await this.runFFmpeg(command);

            // Get optimized file info
            const optimizedStats = await this.getVideoInfo(outputPath);
            const reduction = ((1 - optimizedStats.sizeBytes / originalStats.sizeBytes) * 100).toFixed(1);
            
            console.log(`✅ Optimized: ${optimizedStats.size}MB, ${optimizedStats.duration}s`);
            console.log(`📉 Size reduction: ${reduction}%`);
            console.log(`💾 Saved: ${outputPath}\n`);

            return {
                inputPath,
                outputPath,
                originalSize: originalStats.sizeBytes,
                optimizedSize: optimizedStats.sizeBytes,
                reduction: parseFloat(reduction)
            };

        } catch (error) {
            console.error(`❌ Error processing ${inputPath}:`, error.message);
            throw error;
        }
    }

    buildFFmpegCommand(inputPath, outputPath) {
        const args = [
            '-i', inputPath,
            '-t', this.config.duration.toString(),
            '-an', // Remove audio
            '-c:v', 'libx264',
            '-crf', this.config.quality.toString(),
            '-preset', 'fast',
            '-movflags', '+faststart', // Web optimization
            '-pix_fmt', 'yuv420p', // Compatibility
            '-r', this.config.framerate.toString(),
            '-vf', `scale='min(${this.config.maxWidth},iw)':'min(${this.config.maxHeight},ih)':force_original_aspect_ratio=decrease`,
            '-y', // Overwrite output file
            outputPath
        ];

        return args;
    }

    async runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args);
            
            let errorOutput = '';
            
            ffmpeg.stderr.on('data', (data) => {
                errorOutput += data.toString();
                // Show progress (optional - comment out if too verbose)
                const line = data.toString();
                if (line.includes('time=')) {
                    const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
                    if (timeMatch) {
                        process.stdout.write(`\r⏱️  Processing: ${timeMatch[1]}`);
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                process.stdout.write('\r'); // Clear progress line
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}\n${errorOutput}`));
                }
            });

            ffmpeg.on('error', (error) => {
                reject(new Error(`Failed to start FFmpeg: ${error.message}`));
            });
        });
    }

    async getVideoInfo(filePath) {
        const stats = fs.statSync(filePath);
        const sizeBytes = stats.size;
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

        // Get duration using ffprobe
        const duration = await this.getVideoDuration(filePath);

        return {
            sizeBytes,
            size: sizeMB,
            duration: duration.toFixed(1)
        };
    }

    async getVideoDuration(filePath) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                filePath
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code === 0) {
                    resolve(parseFloat(output.trim()) || 0);
                } else {
                    resolve(0); // Fallback if can't get duration
                }
            });

            ffprobe.on('error', () => {
                resolve(0); // Fallback if ffprobe fails
            });
        });
    }

    async batchOptimize(inputDir, outputDir = null) {
        const files = fs.readdirSync(inputDir)
            .filter(file => /\.(mp4|mov|avi|mkv)$/i.test(file))
            .map(file => path.join(inputDir, file));

        if (files.length === 0) {
            console.log('❌ No video files found in directory');
            return;
        }

        console.log(`🚀 Processing ${files.length} video files...\n`);

        const results = [];
        let totalOriginalSize = 0;
        let totalOptimizedSize = 0;

        for (const inputFile of files) {
            try {
                let outputFile = null;
                if (outputDir) {
                    const filename = path.basename(inputFile, path.extname(inputFile));
                    outputFile = path.join(outputDir, `${filename}${this.config.outputSuffix}.mp4`);
                    
                    // Create output directory if it doesn't exist
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
                }

                const result = await this.optimizeVideo(inputFile, outputFile);
                results.push(result);
                totalOriginalSize += result.originalSize;
                totalOptimizedSize += result.optimizedSize;
                
            } catch (error) {
                console.error(`Failed to process ${inputFile}:`, error.message);
            }
        }

        // Summary
        const totalReduction = ((1 - totalOptimizedSize / totalOriginalSize) * 100).toFixed(1);
        console.log(`\n📊 BATCH SUMMARY:`);
        console.log(`   Files processed: ${results.length}/${files.length}`);
        console.log(`   Total original size: ${(totalOriginalSize / (1024 * 1024)).toFixed(2)}MB`);
        console.log(`   Total optimized size: ${(totalOptimizedSize / (1024 * 1024)).toFixed(2)}MB`);
        console.log(`   Total reduction: ${totalReduction}%`);

        return results;
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
🎬 Video Optimizer for Web Backgrounds

Usage:
  node video-optimizer.js <input-file> [output-file]
  node video-optimizer.js --batch <input-directory> [output-directory]
  node video-optimizer.js --config

Examples:
  node video-optimizer.js video.mp4
  node video-optimizer.js video.mp4 optimized.mp4
  node video-optimizer.js --batch ./videos ./optimized
  
Options:
  --batch    Process all videos in a directory
  --config   Show current configuration
  --help     Show this help message

Configuration can be changed by editing the DEFAULT_CONFIG object in the script.
        `);
        return;
    }

    const optimizer = new VideoOptimizer();

    try {
        if (args[0] === '--config') {
            console.log('Current configuration:', JSON.stringify(optimizer.config, null, 2));
            return;
        }

        if (args[0] === '--batch') {
            const inputDir = args[1];
            const outputDir = args[2];
            
            if (!inputDir) {
                console.error('❌ Please specify input directory for batch processing');
                return;
            }

            await optimizer.batchOptimize(inputDir, outputDir);
        } else {
            const inputFile = args[0];
            const outputFile = args[1];
            await optimizer.optimizeVideo(inputFile, outputFile);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Check if FFmpeg is available
function checkFFmpeg() {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);
        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                console.error(`
❌ FFmpeg not found! Please install FFmpeg first:

macOS: brew install ffmpeg
Ubuntu/Debian: sudo apt install ffmpeg
Windows: Download from https://ffmpeg.org/download.html

Or use a package manager like chocolatey: choco install ffmpeg
                `);
                process.exit(1);
            }
            resolve();
        });
        ffmpeg.on('error', () => {
            console.error('❌ FFmpeg not found in PATH');
            process.exit(1);
        });
    });
}

if (require.main === module) {
    checkFFmpeg().then(() => main());
}

module.exports = VideoOptimizer;