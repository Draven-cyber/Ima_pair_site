const Mega = require('megajs');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

class MegaStorage {
    constructor(email, password, folderName = 'Dark_Ima_Sessions') {
        this.email = email;
        this.password = password;
        this.folderName = folderName;
        this.storage = null;
        this.sessionFolder = null;
        this.connected = false;
    }

    async connect() {
        if (this.connected && this.storage) return true;
        
        try {
            console.log(chalk.yellow('🔄 Connecting to Mega.nz...'));
            
            this.storage = new Mega({
                email: this.email,
                password: this.password,
                autologin: true,
                keepalive: true
            });

            await new Promise((resolve, reject) => {
                this.storage.on('ready', () => {
                    console.log(chalk.green('✓ Connected to Mega.nz'));
                    this.connected = true;
                    resolve();
                });
                this.storage.on('error', (err) => {
                    console.log(chalk.red('Mega connection error:', err.message));
                    reject(err);
                });
                this.storage.login();
            });

            // Find or create session folder
            const rootFiles = await this.storage.get('', { includeFiles: true });
            this.sessionFolder = rootFiles.children.find(f => f.name === this.folderName);
            
            if (!this.sessionFolder) {
                this.sessionFolder = await this.storage.mkdir({ name: this.folderName });
                console.log(chalk.green(`✓ Created folder: ${this.folderName}`));
            }

            return true;
        } catch (error) {
            console.error('Failed to connect to Mega:', error);
            this.connected = false;
            return false;
        }
    }

    async saveSession(sessionId, sessionData) {
        try {
            if (!this.connected) await this.connect();

            const fileName = `${sessionId}.json`;
            const fileContent = JSON.stringify(sessionData, null, 2);

            // Check if file exists
            const existingFile = this.sessionFolder.children?.find(f => f.name === fileName);
            
            if (existingFile) {
                await existingFile.upload(Buffer.from(fileContent));
                console.log(chalk.green(`✓ Updated session: ${fileName}`));
            } else {
                await this.sessionFolder.upload({ name: fileName }, Buffer.from(fileContent));
                console.log(chalk.green(`✓ Saved session: ${fileName}`));
            }

            return {
                success: true,
                path: `Mega/${this.folderName}/${fileName}`
            };
        } catch (error) {
            console.error('Failed to save session to Mega:', error);
            return { success: false, error: error.message };
        }
    }

    async loadSession(sessionId) {
        try {
            if (!this.connected) await this.connect();

            // Refresh folder
            this.sessionFolder = await this.storage.get(this.sessionFolder.objectId, { includeFiles: true });
            
            const file = this.sessionFolder.children?.find(f => f.name === `${sessionId}.json`);
            
            if (!file) {
                return { success: false, error: 'Session not found' };
            }

            const content = await file.downloadBuffer();
            const sessionData = JSON.parse(content.toString());

            return {
                success: true,
                data: sessionData
            };
        } catch (error) {
            console.error('Failed to load session from Mega:', error);
            return { success: false, error: error.message };
        }
    }

    async listSessions() {
        try {
            if (!this.connected) await this.connect();

            this.sessionFolder = await this.storage.get(this.sessionFolder.objectId, { includeFiles: true });
            
            const sessions = (this.sessionFolder.children || [])
                .filter(f => f.name.endsWith('.json'))
                .map(f => ({
                    id: f.name.replace('.json', ''),
                    name: f.name,
                    size: f.size,
                    createdAt: f.timestamp,
                    downloadUrl: f.downloadUrl
                }));

            return {
                success: true,
                sessions: sessions
            };
        } catch (error) {
            console.error('Failed to list sessions:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteSession(sessionId) {
        try {
            if (!this.connected) await this.connect();

            this.sessionFolder = await this.storage.get(this.sessionFolder.objectId, { includeFiles: true });
            
            const file = this.sessionFolder.children?.find(f => f.name === `${sessionId}.json`);
            
            if (!file) {
                return { success: false, error: 'Session not found' };
            }

            await file.delete();
            console.log(chalk.yellow(`✓ Deleted session: ${sessionId}.json`));

            return { success: true };
        } catch (error) {
            console.error('Failed to delete session:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = MegaStorage;
