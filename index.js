const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { Server } = require("socket.io");
const http = require("http");
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server,{ cors: { origin: "*" } });
const cors = require('cors');
const PORT = process.env.PORT ||5050;
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const frontendPath = path.join(__dirname, '../../frontend');
const frameDir = path.join(__dirname, 'static/frames');
app.use(cors());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

app.use(express.static(frontendPath)); 
app.use('/static', express.static(path.join(__dirname, 'static')));

const upload = multer({ dest: 'uploads/' });
const rateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 100, 
    message: {
        status: 429,
        error: "Drone upload limit exceeded. Please wait a moment."
    },
    standardHeaders: true, 
    legacyHeaders: false,  
});

app.post('/upload', rateLimiter,upload.single('video'), (req, res) => {
    let telemetry = [];
    try {
        telemetry = JSON.parse(req.body.telemetry || "[]");
    } catch (e) {
        console.error("Invalid telemetry JSON received");
    }

    const videoPath = req.file.path;
    const originalName = req.file.originalname.replace(/\s+/g, '_');
    const outputPattern = path.join(frameDir, `${originalName}-%03d.jpg`);

    res.json({ status: "Processing Started", originalName: originalName });

    ffmpeg(videoPath)
        .fps(1) 
        .outputOptions('-q:v 2')
        .on('end', async () => {
            const frameFiles = fs.readdirSync(frameDir)
                .filter(f => f.startsWith(originalName))
                .sort();

            
            for (let i = 0; i < frameFiles.length; i++) {
                const fileName = frameFiles[i];
                const fullImagePath = path.resolve(frameDir, fileName);

                const currentData = telemetry[i] || {
                    drone_id: "Unknown",
                    timestamp: `00:00:${i.toString().padStart(2, '0')}`,
                    gps: { lat: 0, lng: 0 }
                };

                try {
                    const imageBase64 = fs.readFileSync(fullImagePath, { encoding: 'base64' });
                    const aiResponse = await axios.post('https://sameer007123-drone-ai-brain.hf.space/tag', { 
                        image: imageBase64,
                        droneID: currentData.drone_id,
                        gps: currentData.gps,
                        timestamp: currentData.timestamp
                    });

                    const aiData = aiResponse.data;

                    const resultEntry = {
                        tag: aiData.tags.simple_tags ? aiData.tags.simple_tags.join(', ') : "scanning",
                        contextTags:aiData.tags.context_tags? aiData.tags.context_tags:"",
                        caption: aiData.caption || "",
                        droneID: aiData.metadata?.droneID || currentData.drone_id,
                        timestamp: aiData.metadata?.timestamp || currentData.timestamp,
                        gps: aiData.metadata?.gps || currentData.gps,
                        imageUrl: `/static/frames/${fileName}`
                    };
                    
                    console.log(resultEntry);
                    io.emit('new-frame', resultEntry);
                    // console.log(`Indexed frame ${i}: ${resultEntry.tag}`);
                    console.log(resultEntry);
                } catch (err) {
                    console.error(`AI Error at frame ${i}:`, err.message);
                    io.emit('new-frame', {
                        tag: "AI Error",
                        timestamp: currentData.timestamp,
                        gps: currentData.gps,
                        imageUrl: `/static/frames/${fileName}`
                    });
                }
            }

            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); 
            console.log("✅ Processing Complete for " + originalName);
        })
        .on('error', (err) => {
            console.error('FFmpeg Error:', err);
        })
        .save(outputPattern);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
