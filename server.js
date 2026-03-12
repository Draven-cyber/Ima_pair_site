const express = require('express');
const path = require('path');
const http = require('http');
const socketIO = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs-extra');
const chalk = require('chalk');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cron = require('node-cron');
const MegaStorage = require('./mega-storage');
const GitHubSync = require('./github-sync');
const config = require('./config');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize services
const megaStorage = new MegaStorage(
    config.mega.email,
    config.mega.password,
    config.mega.sessionFolder
);
const githubSync = new GitHubSync();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(config.server.publicPath));

// Session middleware
app.use(session({
    secret: 'dark-ima-pair-site-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// Ensure directories exist
fs.ensureDirSync(config.server.sessionPath);
fs.ensureDirSync(path.join(config.server.publicPath, 'images'));

// Store active pairing sessions
const activeSessions = new Map();
const connectedBots = new Map();

// ============================================
// PAIRING CODE GENERATION
// ============================================

async function generatePairingCode(phoneNumber) {
    try {
        console.log(chalk.blue(`🔄 Generating pairing code for: ${phoneNumber}`));
        
        // Clean phone number
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        // Format with country code (default 94 for Sri Lanka)
        if (cleanNumber.length === 9) {
            cleanNumber = '94' + cleanNumber;
        } else if (cleanNumber.startsWith('0')) {
            cleanNumber = '94' + cleanNumber.substring(1);
        }
        
        // Generate session ID with Dark_Ima_ prefix
        const timestamp = Date.now();
        const randomStr = crypto.randomBytes(4).toString('hex');
        const sessionId = `Dark_Ima_${cleanNumber}_${timestamp}_${randomStr}`;
        
        // Create session directory
        const sessionDir = path.join(config.server.sessionPath, sessionId);
        fs.ensureDirSync(sessionDir);
        
        // Get latest Baileys version
        const { version } = await fetchLatestBaileysVersion();
        
        // Load auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // Create socket
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Dark Ima Pair Site', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 60000
        });

        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);

        // Wait for socket to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Request pairing code
        let pairingCode = null;
        let retries = 3;
        
        while (retries > 0 && !pairingCode) {
            try {
                pairingCode = await sock.requestPairingCode(cleanNumber);
                
                if (pairingCode) {
                    const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
                    
                    // Store session info
                    activeSessions.set(sessionId, {
                        phoneNumber: cleanNumber,
                        code: pairingCode,
                        formattedCode: formattedCode,
                        sessionDir: sessionDir,
                        sock: sock,
                        sessionId: sessionId,
                        status: 'code_generated',
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 120000 // 2 minutes
                    });
                    
                    return {
                        success: true,
                        code: formattedCode,
                        sessionId: sessionId,
                        phoneNumber: cleanNumber
                    };
                }
            } catch (error) {
                console.log(chalk.red(`❌ Attempt failed: ${error.message}`));
                retries--;
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
        
        throw new Error('Failed to generate pairing code');
        
    } catch (error) {
        console.error(chalk.red('❌ Pairing error:', error));
        return { success: false, error: error.message };
    }
}

// ============================================
// API ENDPOINTS
// ============================================

// Generate pairing code
app.post('/api/pair/generate', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }
        
        const result = await generatePairingCode(phoneNumber);
        
        if (result.success) {
            res.json({
                success: true,
                sessionId: result.sessionId,
                code: result.code,
                message: 'Pairing code generated successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check login status
app.get('/api/session/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.json({
            success: false,
            error: 'Session not found',
            status: 'expired'
        });
    }
    
    try {
        const credsPath = path.join(session.sessionDir, 'creds.json');
        
        if (await fs.pathExists(credsPath)) {
            const creds = await fs.readJSON(credsPath);
            
            if (creds.registered && creds.me) {
                session.status = 'connected';
                
                // Save session to Mega
                const megaResult = await megaStorage.saveSession(sessionId, creds);
                
                if (megaResult.success) {
                    console.log(chalk.green(`✓ Session saved to Mega: ${sessionId}`));
                    
                    // Send message to linked device
                    try {
                        await session.sock.sendMessage(creds.me.id, {
                            text: `✅ *Your session has been saved successfully!*\n\n` +
                                  `📱 *Session ID:* \`${sessionId}\`\n` +
                                  `💾 *Saved to:* Mega.nz (${config.mega.sessionFolder})\n` +
                                  `👤 *Number:* ${session.phoneNumber}\n\n` +
                                  `> ${config.bot.footer}`
                        });
                    } catch (msgError) {
                        console.log(chalk.yellow('Could not send message to device:', msgError.message));
                    }
                    
                    // Store in connected bots
                    connectedBots.set(session.phoneNumber, {
                        sessionId,
                        jid: creds.me.id,
                        name: creds.me.name,
                        connectedAt: Date.now()
                    });
                }
                
                return res.json({
                    success: true,
                    status: 'connected',
                    loggedIn: true,
                    sessionId: sessionId,
                    user: {
                        id: creds.me.id,
                        name: creds.me.name || 'Unknown',
                        phone: session.phoneNumber
                    },
                    megaSaved: megaResult.success
                });
            }
        }
        
        res.json({
            success: true,
            status: session.status,
            loggedIn: false,
            expiresIn: Math.floor((session.expiresAt - Date.now()) / 1000)
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Download session file
app.get('/api/session/download/:sessionId/:type', async (req, res) => {
    const { sessionId, type } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
    
    try {
        const credsPath = path.join(session.sessionDir, 'creds.json');
        
        if (!await fs.pathExists(credsPath)) {
            return res.status(404).json({
                success: false,
                error: 'Session files not found'
            });
        }
        
        const creds = await fs.readJSON(credsPath);
        
        if (type === 'creds') {
            res.download(credsPath, `creds_${session.phoneNumber}.json`);
        } else if (type === 'full') {
            // Create zip of all session files
            const archiver = require('archiver');
            const zipPath = path.join(config.server.sessionPath, `${sessionId}.zip`);
            
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            
            archive.pipe(output);
            
            // Add all session files
            const files = await fs.readdir(session.sessionDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(session.sessionDir, file);
                    archive.file(filePath, { name: `session/${file}` });
                }
            }
            
            // Add README
            const readme = `# WhatsApp Session Files
Session ID: ${sessionId}
Phone: ${session.phoneNumber}
Date: ${new Date().toISOString()}
${config.bot.footer}`;
            
            archive.append(readme, { name: 'README.txt' });
            
            await archive.finalize();
            
            output.on('close', () => {
                res.download(zipPath, `session_${session.phoneNumber}.zip`, (err) => {
                    if (err) console.error('Download error:', err);
                    setTimeout(() => fs.remove(zipPath).catch(console.error), 5000);
                });
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get session info
app.get('/api/session/info/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        // Check if in Mega
        const megaResult = await megaStorage.loadSession(sessionId);
        if (megaResult.success) {
            return res.json({
                success: true,
                fromMega: true,
                sessionId: sessionId,
                data: {
                    registered: true,
                    me: megaResult.data.me
                }
            });
        }
        
        return res.status(404).json({
            success: false,
            error: 'Session not found'
        });
    }
    
    try {
        const credsPath = path.join(session.sessionDir, 'creds.json');
        
        if (await fs.pathExists(credsPath)) {
            const creds = await fs.readJSON(credsPath);
            
            res.json({
                success: true,
                sessionId: sessionId,
                phoneNumber: session.phoneNumber,
                status: session.status,
                loggedIn: creds.registered && creds.me,
                user: creds.me ? {
                    id: creds.me.id,
                    name: creds.me.name
                } : null
            });
        } else {
            res.json({
                success: true,
                sessionId: sessionId,
                phoneNumber: session.phoneNumber,
                status: session.status,
                loggedIn: false
            });
        }
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

// List all sessions from Mega
app.get('/api/sessions/list', async (req, res) => {
    const result = await megaStorage.listSessions();
    res.json(result);
});

// Delete session
app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    // Delete from Mega
    const megaResult = await megaStorage.deleteSession(sessionId);
    
    // Delete local session
    const session = activeSessions.get(sessionId);
    if (session) {
        await fs.remove(session.sessionDir);
        activeSessions.delete(sessionId);
    }
    
    res.json({
        success: true,
        message: 'Session deleted successfully'
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: activeSessions.size,
        connectedBots: connectedBots.size,
        megaConnected: megaStorage.connected,
        footer: config.bot.footer
    });
});

// ============================================
// AUTO-UPDATE SYSTEM
// ============================================

// Initialize GitHub sync
githubSync.init().catch(console.error);

// Check for updates periodically
if (config.autoUpdate.enabled) {
    setInterval(async () => {
        try {
            const update = await githubSync.checkForUpdates();
            
            if (update.hasUpdate) {
                console.log(chalk.yellow('📦 Update found! Pulling changes...'));
                
                const result = await githubSync.pullUpdates();
                
                if (result.success && config.autoUpdate.restartAfterUpdate) {
                    console.log(chalk.yellow('🔄 Restarting server to apply updates...'));
                    process.exit(0);
                }
            }
        } catch (error) {
            console.error(chalk.red('Auto-update error:', error.message));
        }
    }, config.autoUpdate.interval);
    
    console.log(chalk.green(`✓ Auto-update enabled (checking every ${config.autoUpdate.interval / 60000} minutes)`));
}

// Webhook for GitHub pushes
app.post('/api/github/webhook', express.json({ type: 'application/json' }), async (req, res) => {
    const event = req.headers['x-github-event'];
    
    if (event === 'push') {
        console.log(chalk.blue('📦 GitHub push event received'));
        
        const result = await githubSync.pullUpdates();
        
        if (result.success && config.autoUpdate.restartAfterUpdate) {
            setTimeout(() => {
                console.log(chalk.yellow('🔄 Restarting server to apply updates...'));
                process.exit(0);
            }, 3000);
        }
        
        res.json({ success: true, message: 'Update initiated' });
    } else {
        res.json({ success: true, message: 'Event received' });
    }
});

// ============================================
// SOCKET.IO
// ============================================

io.on('connection', (socket) => {
    console.log(chalk.green('✓ Client connected to socket'));
    
    socket.on('join-session', (sessionId) => {
        socket.join(`session-${sessionId}`);
        console.log(chalk.blue(`Socket joined room: session-${sessionId}`));
    });
    
    socket.on('disconnect', () => {
        console.log(chalk.yellow('Client disconnected from socket'));
    });
});

// ============================================
// CLEANUP OLD SESSIONS
// ============================================

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now > session.expiresAt + 300000) { // 5 minutes after expiry
            fs.remove(session.sessionDir).catch(console.error);
            activeSessions.delete(sessionId);
            console.log(chalk.yellow(`🧹 Cleaned up session: ${sessionId}`));
        }
    }
}, 60000);

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(config.server.publicPath, 'index.html'));
});

app.get('/pair', (req, res) => {
    res.sendFile(path.join(config.server.publicPath, 'pair.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(config.server.publicPath, 'success.html'));
});

// ============================================
// START SERVER
// ============================================

server.listen(config.server.port, '0.0.0.0', async () => {
    console.log(chalk.magenta('╔════════════════════════════════════╗'));
    console.log(chalk.magenta('║        Dark Ima Pair Site         ║'));
    console.log(chalk.magenta('╚════════════════════════════════════╝\n'));
    
    console.log(chalk.cyan(`🌐 Server running on: http://localhost:${config.server.port}`));
    console.log(chalk.cyan(`📱 Pairing page: http://localhost:${config.server.port}/pair`));
    console.log(chalk.cyan(`📊 Health check: http://localhost:${config.server.port}/api/health\n`));
    
    // Connect to Mega
    await megaStorage.connect();
    
    console.log(chalk.green(`✓ ${config.bot.footer}`));
});

// Handle process termination
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n👋 Shutting down...'));
    
    // Clean up sessions
    for (const [sessionId, session] of activeSessions.entries()) {
        await fs.remove(session.sessionDir).catch(console.error);
    }
    
    server.close(() => {
        console.log(chalk.green('✓ Server closed'));
        process.exit(0);
    });
});

process.on('uncaughtException', (err) => {
    console.error(chalk.red('Uncaught exception:', err));
});

module.exports = app;
