const path = require('path');

module.exports = {
    // Mega.nz Configuration
    mega: {
        email: process.env.MEGA_EMAIL || 'Rithikaimansara25894@gmail.com',
        password: process.env.MEGA_PASSWORD || 'Rithika25894#',
        sessionFolder: 'Dark_Ima_Sessions'
    },
    
    // GitHub Configuration
    github: {
        token: process.env.GITHUB_TOKEN || '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',
        owner: process.env.GITHUB_OWNER || 'Draven-cyber',
        repo: process.env.GITHUB_REPO || 'Ima_pair_site',
        branch: 'main'
    },
    
    // Bot Configuration
    bot: {
        name: 'Dark Ima Pair Site',
        prefix: '.',
        footer: 'Made by Dark Ima 🌑',
        sessionPrefix: 'Dark_Ima_',
        maxFileSize: 100 * 1024 * 1024, // 100MB
        otpExpiry: 300000 // 5 minutes
    },
    
    // Server Configuration
    server: {
        port: process.env.PORT || 3000,
        sessionPath: path.join(__dirname, 'sessions'),
        publicPath: path.join(__dirname, 'public')
    },
    
    // Auto-Update Configuration
    autoUpdate: {
        enabled: true,
        interval: 5 * 60 * 1000, // 5 minutes
        restartAfterUpdate: true
    }
};
