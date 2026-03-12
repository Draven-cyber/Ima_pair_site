const express = require('express');
const path = require('path');
const http = require('http');
const socketIO = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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
const MegaStorage = require('./mega-storage');
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

// Initialize Mega storage
const megaStorage = new MegaStorage(
    config.mega.email,
    config.mega.password,
    config.mega.sessionFolder
);

// Ensure directories exist
fs.ensureDirSync(config.server.sessionPath);
fs.ensureDirSync(path.join(config.server.publicPath, 'images'));

// Store active pairing sessions
const activeSessions = new Map();

// Middleware setup
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(config.server.publicPath));

// ============================================
// FIXED PAIRING CODE GENERATION WITH LOGIN DETECTION
// ============================================

async function generatePairingCode(phoneNumber) {
    try {
        console.log(chalk.blue(`🔄 Generating pairing code for: ${phoneNumber}`));
        
        // Clean phone number
        let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        // Format with country code
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
        
        // Create socket with proper configuration
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.appropriate('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: false
        });

        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);

        // FIX: Properly detect connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(chalk.yellow(`📡 Connection update for ${cleanNumber}:`, connection || 'connecting'));
            
            if (connection === 'open') {
                console.log(chalk.green(`✅ User ${cleanNumber} successfully logged in!`));
                
                // Get user info
                const userJid = sock.user.id;
                const userName = sock.user.name || 'User';
                
                // Update session status
                const session = activeSessions.get(sessionId);
                if (session) {
                    session.status = 'connected';
                    session.userJid = userJid;
                    session.userName = userName;
                    session.connectedAt = Date.now();
                    activeSessions.set(sessionId, session);
                    
                    // Read creds file to get full info
                    try {
                        const credsPath = path.join(sessionDir, 'creds.json');
                        if (await fs.pathExists(credsPath)) {
                            const creds = await fs.readJSON(credsPath);
                            
                            // Save to Mega
                            await megaStorage.saveSession(sessionId, creds);
                            console.log(chalk.green(`✓ Session saved to Mega: ${sessionId}`));
                            
                            // FIX: Send confirmation message to WhatsApp
                            try {
                                // Send detailed success message
                                await sock.sendMessage(userJid, {
                                    text: `✅ *WhatsApp Session Connected Successfully!*\n\n` +
                                          `📱 *Number:* ${cleanNumber}\n` +
                                          `🆔 *Session ID:* \`${sessionId}\`\n` +
                                          `💾 *Saved to:* Mega.nz (${config.mega.sessionFolder})\n` +
                                          `📅 *Time:* ${new Date().toLocaleString()}\n\n` +
                                          `🔐 *Your session is now active and backed up securely.*\n\n` +
                                          `> ${config.bot.footer}`
                                });
                                
                                // Also send a simple sticker/message to confirm
                                await sock.sendMessage(userJid, {
                                    text: `🎉 *Welcome to Dark Ima Bot!*\nUse .menu to see available commands.`
                                });
                                
                                console.log(chalk.green(`✓ Confirmation message sent to ${cleanNumber}`));
                            } catch (msgError) {
                                console.log(chalk.yellow('Could not send message to device:', msgError.message));
                            }
                            
                            // Emit socket event
                            io.to(`session-${sessionId}`).emit('login-success', {
                                sessionId,
                                userJid,
                                userName,
                                phoneNumber: cleanNumber
                            });
                        }
                    } catch (error) {
                        console.error(chalk.red('Error saving session:', error));
                    }
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(chalk.yellow(`Connection closed for ${cleanNumber}. Reconnect: ${shouldReconnect}`));
                
                if (!shouldReconnect) {
                    // User logged out
                    const session = activeSessions.get(sessionId);
                    if (session) {
                        session.status = 'logged_out';
                        activeSessions.set(sessionId, session);
                        
                        io.to(`session-${sessionId}`).emit('logout', {
                            message: 'User logged out'
                        });
                    }
                }
            }
        });

        // FIX: Monitor messages to detect when device is ready
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify') {
                // This confirms the socket is receiving messages (user is logged in)
                console.log(chalk.green(`📨 Messages detected for ${cleanNumber} - User is active`));
                
                // Check if we haven't already marked as connected
                const session = activeSessions.get(sessionId);
                if (session && session.status !== 'connected') {
                    console.log(chalk.green(`✓ User ${cleanNumber} is now active!`));
                    
                    // This will trigger the connection update handler
                }
            }
        });

        // Wait for socket to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Request pairing code with retry
        let pairingCode = null;
        let retries = 3;
        
        while (retries > 0 && !pairingCode) {
            try {
                console.log(chalk.blue(`🔄 Requesting pairing code for ${cleanNumber} (attempt ${4 - retries}/3)...`));
                
                pairingCode = await sock.requestPairingCode(cleanNumber);
                
                if (pairingCode) {
                    const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
                    
                    console.log(chalk.green(`✅ Pairing code generated: ${formattedCode}`));
                    
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
        
        throw new Error('Failed to generate pairing code after multiple attempts');
        
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

// FIX: Improved login status check
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
            
            // Check if registered AND has me object (fully logged in)
            if (creds.registered && creds.me && session.status === 'connected') {
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
                    megaSaved: true
                });
            } else if (creds.registered) {
                // Registered but not yet marked as connected
                return res.json({
                    success: true,
                    status: 'registered',
                    loggedIn: false
                });
            }
        }
        
        // Check if session exists but not logged in
        res.json({
            success: true,
            status: session.status || 'pending',
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

// FIX: Force check login endpoint
app.get('/api/session/force-check/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.json({
            success: false,
            error: 'Session not found'
        });
    }
    
    try {
        // Force check by reading creds directly
        const credsPath = path.join(session.sessionDir, 'creds.json');
        
        if (await fs.pathExists(credsPath)) {
            const stats = await fs.stat(credsPath);
            const creds = await fs.readJSON(credsPath);
            
            // Check if file was recently modified (new login)
            const now = Date.now();
            const fileAge = now - stats.mtimeMs;
            
            if (creds.registered && creds.me) {
                // Mark session as connected
                session.status = 'connected';
                activeSessions.set(sessionId, session);
                
                // Save to Mega
                await megaStorage.saveSession(sessionId, creds);
                
                // Send confirmation message if not already sent
                try {
                    await session.sock.sendMessage(creds.me.id, {
                        text: `✅ *Session Connected!*\n\n🆔 ${sessionId}\n💾 Saved to Mega.nz\n\n> ${config.bot.footer}`
                    });
                } catch (msgError) {
                    console.log('Could not send message:', msgError.message);
                }
                
                return res.json({
                    success: true,
                    loggedIn: true,
                    user: {
                        id: creds.me.id,
                        name: creds.me.name,
                        phone: session.phoneNumber
                    },
                    fileAge
                });
            }
        }
        
        res.json({
            success: true,
            loggedIn: false
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
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
        
        // Send initial status
        const session = activeSessions.get(sessionId);
        if (session) {
            socket.emit('session-status', {
                status: session.status,
                sessionId: sessionId
            });
        }
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
            // Close socket connection
            try {
                session.sock?.end();
            } catch (error) {}
            
            // Remove session directory
            fs.remove(session.sessionDir).catch(console.error);
            activeSessions.delete(sessionId);
            console.log(chalk.yellow(`🧹 Cleaned up expired session: ${sessionId}`));
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeSessions: activeSessions.size,
        megaConnected: megaStorage.connected,
        footer: config.bot.footer
    });
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
    
    // Connect to Mega
    await megaStorage.connect();
    
    console.log(chalk.green(`\n✓ ${config.bot.footer}`));
});

// Handle process termination
process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n👋 Shutting down...'));
    
    // Close all socket connections
    for (const [sessionId, session] of activeSessions.entries()) {
        try {
            session.sock?.end();
            await fs.remove(session.sessionDir);
        } catch (error) {}
    }
    
    server.close(() => {
        console.log(chalk.green('✓ Server closed'));
        process.exit(0);
    });
});

module.exports = app;
