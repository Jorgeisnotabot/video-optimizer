const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { promisify } = require('util');

// Enhanced Configuration for better quality with lower bandwidth
const DEFAULT_CONFIG = {
    duration: 15,        // seconds
    startTime: 4,        // seconds to skip from beginning
    quality: {
        webm: 28,        // VP9 CRF (lower = better quality, 23-35 optimal range)
        mp4: 24          // H.264 CRF (lower = better quality, 18-28 optimal range)
    },
    maxWidth: 1920,     // max width in pixels
    maxHeight: 1080,    // max height in pixels
    framerate: 30,      // fps
    outputSuffix: '_optimized_h',
    format: 'webm',     // 'webm' for best compression, 'mp4' for compatibility
    multiQuality: true, // Generate multiple quality versions
    targetBitrate: {    // Target bitrates for different resolutions (kbps)
        '1080p': 2500,
        '720p': 1500,
        '480p': 800
    },
    enableTwoPass: true, // Two-pass encoding for better quality
    audioOptimization: 'remove' // 'remove', 'compress', or 'keep'
};

class EnhancedVideoOptimizer {
    constructor(config = {}) {
        this.config = { 
            ...DEFAULT_CONFIG, 
            ...config,
            quality: { ...DEFAULT_CONFIG.quality, ...(config.quality || {}) },
            targetBitrate: { ...DEFAULT_CONFIG.targetBitrate, ...(config.targetBitrate || {}) }
        };
    }

    async optimizeVideo(inputPath, outputPath = null) {
        try {
            if (!fs.existsSync(inputPath)) {
                throw new Error(`Input file not found: ${inputPath}`);
            }

            // Analyze input video first
            const videoInfo = await this.analyzeVideo(inputPath);
            console.log(`🎬 Optimizing: ${path.basename(inputPath)}`);
            console.log(`📊 Input: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.bitrate}kbps, ${videoInfo.size}MB`);
            console.log(`⏭️  Skipping first ${this.config.startTime}s, using ${this.config.duration}s from ${this.config.startTime}s mark`);

            // Validate that we have enough duration
            if (videoInfo.duration < (this.config.startTime + this.config.duration)) {
                const availableDuration = Math.max(0, videoInfo.duration - this.config.startTime);
                console.log(`⚠️  Warning: Video only has ${availableDuration.toFixed(1)}s available after skipping ${this.config.startTime}s`);
                if (availableDuration < 5) {
                    throw new Error(`Not enough video duration after skipping ${this.config.startTime}s. Need at least 5 seconds.`);
                }
            }

            if (this.config.multiQuality) {
                return await this.generateMultipleQualities(inputPath, outputPath, videoInfo);
            } else {
                return await this.optimizeSingleVideo(inputPath, outputPath, videoInfo);
            }

        } catch (error) {
            console.error(`❌ Error processing ${inputPath}:`, error.message);
            throw error;
        }
    }

    async generateMultipleQualities(inputPath, outputPath, videoInfo) {
        const results = [];
        const baseName = path.basename(inputPath, path.extname(inputPath));
        const baseDir = outputPath ? path.dirname(outputPath) : path.dirname(inputPath);
        
        // Determine which qualities to generate based on input resolution
        const qualities = this.determineOptimalQualities(videoInfo.width, videoInfo.height);
        
        console.log(`📐 Generating ${qualities.length} quality versions: ${qualities.map(q => q.name).join(', ')}`);

        for (const quality of qualities) {
            const qualityOutputPath = path.join(
                baseDir, 
                `${baseName}_${quality.name}${this.config.outputSuffix}.${this.config.format}`
            );

            console.log(`\n🔄 Processing ${quality.name} (${quality.width}x${quality.height})...`);
            
            const command = this.buildOptimizedFFmpegCommand(inputPath, qualityOutputPath, quality, videoInfo);
            await this.runFFmpeg(command);

            const optimizedStats = await this.getVideoInfo(qualityOutputPath);
            const reduction = ((1 - optimizedStats.sizeBytes / videoInfo.sizeBytes) * 100).toFixed(1);
            
            console.log(`✅ ${quality.name}: ${optimizedStats.size}MB (-${reduction}%)`);
            
            results.push({
                quality: quality.name,
                inputPath,
                outputPath: qualityOutputPath,
                originalSize: videoInfo.sizeBytes,
                optimizedSize: optimizedStats.sizeBytes,
                reduction: parseFloat(reduction),
                dimensions: `${quality.width}x${quality.height}`,
                estimatedBitrate: quality.bitrate
            });
        }

        this.printOptimizationSummary(results);
        return results;
    }

    async optimizeSingleVideo(inputPath, outputPath, videoInfo) {
        if (!outputPath) {
            const name = path.basename(inputPath, path.extname(inputPath));
            const dir = path.dirname(inputPath);
            const ext = this.config.format === 'webm' ? '.webm' : '.mp4';
            outputPath = path.join(dir, `${name}${this.config.outputSuffix}${ext}`);
        }

        // Use optimal quality settings based on input
        const quality = this.determineOptimalQualities(videoInfo.width, videoInfo.height)[0];
        const command = this.buildOptimizedFFmpegCommand(inputPath, outputPath, quality, videoInfo);
        
        await this.runFFmpeg(command);

        const optimizedStats = await this.getVideoInfo(outputPath);
        const reduction = ((1 - optimizedStats.sizeBytes / videoInfo.sizeBytes) * 100).toFixed(1);
        
        console.log(`✅ Optimized: ${optimizedStats.size}MB, ${optimizedStats.duration}s`);
        console.log(`📉 Size reduction: ${reduction}%`);
        console.log(`💾 Saved: ${outputPath}\n`);

        return {
            inputPath,
            outputPath,
            originalSize: videoInfo.sizeBytes,
            optimizedSize: optimizedStats.sizeBytes,
            reduction: parseFloat(reduction)
        };
    }

    determineOptimalQualities(inputWidth, inputHeight) {
        const qualities = [];
        
        // Always generate the highest quality that makes sense
        if (inputHeight >= 1080) {
            qualities.push({
                name: '1080p',
                width: 1920,
                height: 1080,
                bitrate: this.config.targetBitrate['1080p']
            });
        }
        
        if (inputHeight >= 720) {
            qualities.push({
                name: '720p',
                width: 1280,
                height: 720,
                bitrate: this.config.targetBitrate['720p']
            });
        }

        // Always include 480p for mobile/slow connections
        qualities.push({
            name: '480p',
            width: 854,
            height: 480,
            bitrate: this.config.targetBitrate['480p']
        });

        // If input is smaller than 480p, just optimize at original size
        if (inputHeight < 480) {
            qualities.length = 0;
            qualities.push({
                name: 'original',
                width: inputWidth,
                height: inputHeight,
                bitrate: Math.min(this.config.targetBitrate['480p'], inputWidth * inputHeight * 0.1)
            });
        }

        return qualities;
    }

    buildOptimizedFFmpegCommand(inputPath, outputPath, quality, videoInfo) {
        const isWebM = this.config.format === 'webm';
        const qualityCRF = isWebM ? this.config.quality.webm : this.config.quality.mp4;
        
        let args = [
            '-ss', this.config.startTime.toString(), // Seek to start time BEFORE input (faster)
            '-i', inputPath,
            '-t', this.config.duration.toString(),   // Duration after seeking
        ];

        // Audio handling
        if (this.config.audioOptimization === 'remove') {
            args.push('-an');
        } else if (this.config.audioOptimization === 'compress') {
            args.push('-c:a', 'aac', '-b:a', '64k', '-ac', '1'); // Mono 64kbps
        }

        // Video encoding settings
        if (isWebM) {
            // VP9 with optimal settings for web delivery
            args.push(
                '-c:v', 'libvpx-vp9',
                '-crf', qualityCRF.toString(),
                '-b:v', `${quality.bitrate}k`, // Target bitrate
                '-minrate', `${Math.floor(quality.bitrate * 0.5)}k`, // Minimum bitrate
                '-maxrate', `${Math.floor(quality.bitrate * 1.45)}k`, // Maximum bitrate
                '-deadline', 'good',
                '-cpu-used', '1', // Slower but better quality
                '-row-mt', '1',
                '-tile-columns', '2',
                '-tile-rows', '1',
                '-g', '240', // Keyframe interval (8 seconds at 30fps)
                '-keyint_min', '30', // Minimum keyframe interval
                '-sc_threshold', '0', // Disable scene change detection
                '-auto-alt-ref', '1', // Enable alternate reference frames
                '-lag-in-frames', '25' // Look-ahead frames
            );
        } else {
            // H.264 with optimal settings
            args.push(
                '-c:v', 'libx264',
                '-crf', qualityCRF.toString(),
                '-maxrate', `${Math.floor(quality.bitrate * 1.2)}k`,
                '-bufsize', `${quality.bitrate * 2}k`,
                '-preset', 'slower', // Better compression
                '-profile:v', 'high',
                '-level', '4.1',
                '-movflags', '+faststart',
                '-pix_fmt', 'yuv420p',
                '-g', '240', // Keyframe interval
                '-keyint_min', '30',
                '-sc_threshold', '40',
                '-refs', '3',
                '-bf', '3',
                '-b_strategy', '2'
            );
        }

        // Scaling with high-quality algorithm
        const scaleFilter = `scale=${quality.width}:${quality.height}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${quality.width}:${quality.height}:(ow-iw)/2:(oh-ih)/2:color=black`;
        
        // Apply additional filters for better quality
        let filters = [scaleFilter];
        
        // Add noise reduction if input bitrate is low (likely compressed source)
        if (videoInfo.bitrate && videoInfo.bitrate < 5000) {
            filters.push('hqdn3d=4:3:6:4.5'); // Temporal and spatial noise reduction
        }
        
        // Add sharpening for upscaled content
        if (quality.width > videoInfo.width || quality.height > videoInfo.height) {
            filters.push('unsharp=5:5:1.0:5:5:0.0'); // Sharpen luma only
        }

        args.push('-vf', filters.join(','));
        
        // Frame rate optimization
        if (this.config.framerate < 60) {
            args.push('-r', this.config.framerate.toString());
        }

        args.push('-y', outputPath);
        return args;
    }

    async analyzeVideo(filePath) {
        return new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                filePath
            ]);

            let output = '';
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code === 0) {
                    try {
                        const data = JSON.parse(output);
                        const videoStream = data.streams.find(s => s.codec_type === 'video');
                        const format = data.format;
                        
                        const stats = fs.statSync(filePath);
                        const sizeBytes = stats.size;
                        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                        
                        resolve({
                            width: parseInt(videoStream.width) || 0,
                            height: parseInt(videoStream.height) || 0,
                            duration: parseFloat(format.duration) || 0,
                            bitrate: parseInt(format.bit_rate) / 1000 || 0, // Convert to kbps
                            codec: videoStream.codec_name,
                            fps: eval(videoStream.r_frame_rate) || 30,
                            sizeBytes,
                            size: sizeMB
                        });
                    } catch (error) {
                        reject(new Error(`Failed to parse video info: ${error.message}`));
                    }
                } else {
                    reject(new Error(`FFprobe failed with code ${code}`));
                }
            });

            ffprobe.on('error', (error) => {
                reject(new Error(`Failed to start FFprobe: ${error.message}`));
            });
        });
    }

    async runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            console.log(`🔧 FFmpeg command: ffmpeg ${args.join(' ')}`);
            const ffmpeg = spawn('ffmpeg', args);
            
            let errorOutput = '';
            let lastProgress = '';
            
            ffmpeg.stderr.on('data', (data) => {
                const line = data.toString();
                errorOutput += line;
                
                // Enhanced progress reporting
                if (line.includes('time=')) {
                    const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
                    const speedMatch = line.match(/speed=\s*(\d+\.?\d*)x/);
                    const bitrateMatch = line.match(/bitrate=\s*(\d+\.?\d*kbits\/s)/);
                    
                    if (timeMatch) {
                        const progress = `⏱️  ${timeMatch[1]}`;
                        const speed = speedMatch ? ` (${speedMatch[1]}x)` : '';
                        const bitrate = bitrateMatch ? ` [${bitrateMatch[1]}]` : '';
                        const fullProgress = `${progress}${speed}${bitrate}`;
                        
                        if (fullProgress !== lastProgress) {
                            process.stdout.write(`\r${fullProgress}`);
                            lastProgress = fullProgress;
                        }
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

    printOptimizationSummary(results) {
        const totalOriginalSize = results.reduce((sum, r) => sum + r.originalSize, 0);
        const totalOptimizedSize = results.reduce((sum, r) => sum + r.optimizedSize, 0);
        const totalReduction = ((1 - totalOptimizedSize / totalOriginalSize) * 100).toFixed(1);
        
        console.log(`\n🎯 OPTIMIZATION SUMMARY:`);
        console.log(`   Generated qualities: ${results.length}`);
        console.log(`   Total size reduction: ${totalReduction}%`);
        console.log(`   Original total: ${(totalOriginalSize / (1024 * 1024)).toFixed(2)}MB`);
        console.log(`   Optimized total: ${(totalOptimizedSize / (1024 * 1024)).toFixed(2)}MB`);
        console.log(`   Bandwidth savings: ${((totalOriginalSize - totalOptimizedSize) / (1024 * 1024)).toFixed(2)}MB`);
        
        console.log(`\n📱 Quality Breakdown:`);
        results.forEach(r => {
            console.log(`   ${r.quality}: ${(r.optimizedSize / (1024 * 1024)).toFixed(2)}MB (${r.dimensions})`);
        });
    }

    async getVideoInfo(filePath) {
        const stats = fs.statSync(filePath);
        const sizeBytes = stats.size;
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
        const duration = await this.getVideoDuration(filePath);

        return {
            sizeBytes,
            size: sizeMB,
            duration: duration.toFixed(1)
        };
    }

    async getVideoDuration(filePath) {
        return new Promise((resolve) => {
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

            ffprobe.on('close', () => {
                resolve(parseFloat(output.trim()) || 0);
            });

            ffprobe.on('error', () => {
                resolve(0);
            });
        });
    }

    async batchOptimize(inputDir, outputDir = null) {
        const files = fs.readdirSync(inputDir)
            .filter(file => /\.(mp4|mov|avi|mkv|webm)$/i.test(file))
            .map(file => path.join(inputDir, file));

        if (files.length === 0) {
            console.log('❌ No video files found in directory');
            return;
        }

        console.log(`🚀 Processing ${files.length} video files with enhanced optimization...\n`);

        const allResults = [];
        for (const inputFile of files) {
            try {
                const results = await this.optimizeVideo(inputFile, outputDir);
                if (Array.isArray(results)) {
                    allResults.push(...results);
                } else {
                    allResults.push(results);
                }
            } catch (error) {
                console.error(`Failed to process ${inputFile}:`, error.message);
            }
        }

        console.log(`\n🎉 BATCH COMPLETE: Generated ${allResults.length} optimized videos`);
        return allResults;
    }
}

// Enhanced CLI Interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
🎬 Enhanced Video Optimizer - Better Quality, Lower Bandwidth

Usage:
  node enhanced-optimizer.js <input-file> [output-file]
  node enhanced-optimizer.js --batch <input-directory> [output-directory]
  node enhanced-optimizer.js --config
  node enhanced-optimizer.js --single <input-file> [output-file]
  node enhanced-optimizer.js --start <seconds> <input-file> [output-file]

Examples:
  node enhanced-optimizer.js video.mp4                    # Multi-quality, skip first 4s
  node enhanced-optimizer.js --start 10 video.mp4         # Skip first 10 seconds instead
  node enhanced-optimizer.js --single video.mp4 out.webm  # Single optimized file
  node enhanced-optimizer.js --batch ./videos ./web-ready # Batch process
  
Options:
  --batch      Process all videos in a directory (multi-quality)
  --single     Generate single optimized video instead of multiple qualities
  --start <n>  Skip first N seconds (default: 4 seconds)
  --config     Show current configuration
  --help       Show this help message

Features:
  ✨ Adaptive quality generation (480p, 720p, 1080p)
  ⏭️  Smart start time skipping (default: skip first 4 seconds)
  🎯 Optimized encoding settings for web delivery
  📱 Mobile-friendly output with bandwidth awareness
  🔧 Advanced filtering for better visual quality
  📊 Detailed analytics and optimization reporting
        `);
        return;
    }

    // Enhanced config for better quality
    const enhancedConfig = {
        ...DEFAULT_CONFIG,
        multiQuality: !args.includes('--single')
    };

    const optimizer = new EnhancedVideoOptimizer(enhancedConfig);

    try {
        if (args[0] === '--config') {
            console.log('🔧 Current Enhanced Configuration:');
            console.log(JSON.stringify(optimizer.config, null, 2));
            return;
        }

        // Handle --start option
        if (args[0] === '--start') {
            const startTime = parseInt(args[1]);
            if (isNaN(startTime) || startTime < 0) {
                console.error('❌ Invalid start time. Please provide a positive number.');
                return;
            }
            enhancedConfig.startTime = startTime;
            args.splice(0, 2); // Remove --start and the number
            console.log(`⏭️  Custom start time: ${startTime} seconds`);
        }

        // Recreate optimizer with updated config
        const optimizer = new EnhancedVideoOptimizer(enhancedConfig);

        if (args[0] === '--batch') {
            const inputDir = args[1];
            const outputDir = args[2];
            
            if (!inputDir) {
                console.error('❌ Please specify input directory for batch processing');
                return;
            }

            await optimizer.batchOptimize(inputDir, outputDir);
        } else {
            const isSingle = args[0] === '--single';
            const inputFile = isSingle ? args[1] : args[0];
            const outputFile = isSingle ? args[2] : args[1];
            
            if (isSingle) {
                optimizer.config.multiQuality = false;
            }
            
            await optimizer.optimizeVideo(inputFile, outputFile);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// FFmpeg check with enhanced error handling
function checkFFmpeg() {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);
        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                console.error(`
❌ FFmpeg not found! Please install FFmpeg with libvpx-vp9 support:

macOS: brew install ffmpeg
Ubuntu/Debian: sudo apt install ffmpeg
Windows: Download from https://ffmpeg.org/download.html

For best results, ensure VP9 codec support:
ffmpeg -codecs | grep vp9
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

module.exports = EnhancedVideoOptimizer;