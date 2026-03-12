const simpleGit = require('simple-git');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { Octokit } = require('@octokit/rest');
const config = require('./config');

class GitHubSync {
    constructor() {
        this.git = simpleGit();
        this.octokit = new Octokit({ auth: config.github.token });
        this.repoDir = process.cwd();
        this.lastCommit = null;
    }

    async init() {
        try {
            // Check if git repository exists
            const isRepo = await this.git.checkIsRepo();
            
            if (!isRepo) {
                console.log(chalk.yellow('Initializing git repository...'));
                await this.git.init();
                await this.git.addRemote('origin', `https://github.com/${config.github.owner}/${config.github.repo}.git`);
            }

            // Get latest commit from GitHub
            const { data } = await this.octokit.repos.getCommit({
                owner: config.github.owner,
                repo: config.github.repo,
                ref: config.github.branch
            });

            this.lastCommit = data.sha;
            console.log(chalk.green(`✓ Current commit: ${this.lastCommit.substring(0, 7)}`));

            return true;
        } catch (error) {
            console.error(chalk.red('GitHub sync init error:', error.message));
            return false;
        }
    }

    async checkForUpdates() {
        try {
            console.log(chalk.blue('🔄 Checking for updates...'));

            // Get latest commit from GitHub
            const { data } = await this.octokit.repos.getCommit({
                owner: config.github.owner,
                repo: config.github.repo,
                ref: config.github.branch
            });

            const latestCommit = data.sha;

            if (this.lastCommit !== latestCommit) {
                console.log(chalk.yellow(`📦 Update available: ${this.lastCommit?.substring(0, 7)} → ${latestCommit.substring(0, 7)}`));
                return {
                    hasUpdate: true,
                    latestCommit,
                    message: data.commit.message
                };
            }

            console.log(chalk.green('✓ No updates available'));
            return { hasUpdate: false };
        } catch (error) {
            console.error(chalk.red('Update check error:', error.message));
            return { hasUpdate: false, error: error.message };
        }
    }

    async pullUpdates() {
        try {
            console.log(chalk.blue('📥 Pulling updates from GitHub...'));

            // Stash any local changes
            await this.git.stash();

            // Pull latest changes
            await this.git.pull('origin', config.github.branch);

            // Get new commit
            const log = await this.git.log({ maxCount: 1 });
            this.lastCommit = log.latest?.hash;

            console.log(chalk.green(`✓ Updated to commit: ${this.lastCommit?.substring(0, 7)}`));

            // Install any new dependencies
            await this.installDependencies();

            return { success: true, commit: this.lastCommit };
        } catch (error) {
            console.error(chalk.red('Pull updates error:', error.message));
            return { success: false, error: error.message };
        }
    }

    async installDependencies() {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            exec('npm install', (error, stdout, stderr) => {
                if (error) {
                    console.error(chalk.red('npm install error:', error));
                    reject(error);
                } else {
                    console.log(chalk.green('✓ Dependencies installed'));
                    resolve();
                }
            });
        });
    }

    async getFileContent(filePath) {
        try {
            const { data } = await this.octokit.repos.getContent({
                owner: config.github.owner,
                repo: config.github.repo,
                path: filePath,
                ref: config.github.branch
            });

            if (data.content) {
                const content = Buffer.from(data.content, 'base64').toString('utf8');
                return { success: true, content, sha: data.sha };
            }

            return { success: false, error: 'No content' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async updateFile(filePath, content, message = 'Update file') {
        try {
            // Check if file exists
            let sha;
            try {
                const { data } = await this.octokit.repos.getContent({
                    owner: config.github.owner,
                    repo: config.github.repo,
                    path: filePath
                });
                sha = data.sha;
            } catch (error) {
                // File doesn't exist, no SHA needed
            }

            await this.octokit.repos.createOrUpdateFileContents({
                owner: config.github.owner,
                repo: config.github.repo,
                path: filePath,
                message,
                content: Buffer.from(content).toString('base64'),
                sha,
                branch: config.github.branch
            });

            return { success: true };
        } catch (error) {
            console.error(chalk.red('Update file error:', error.message));
            return { success: false, error: error.message };
        }
    }
}

module.exports = GitHubSync;
