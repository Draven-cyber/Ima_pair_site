// Initialize socket
const socket = io();

// DOM Elements
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const phoneInput = document.getElementById('phoneNumber');
const generateBtn = document.getElementById('generateBtn');
const pairingCodeSpan = document.getElementById('pairingCode');
const timerSpan = document.getElementById('timer');
const loginStatus = document.getElementById('loginStatus');
const cancelBtn = document.getElementById('cancelBtn');
const sessionIdSpan = document.getElementById('sessionId');

// State
let currentSessionId = null;
let countdownInterval = null;
let loginCheckInterval = null;

// Show toast notification
function showToast(message, type = 'info') {
    // Create toast container if not exists
    let toastContainer = document.querySelector('.toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        toastContainer.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999;
        `;
        document.body.appendChild(toastContainer);
    }
    
    const toast = document.createElement('div');
    toast.style.cssText = `
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        padding: 15px 20px;
        border-radius: 10px;
        margin-bottom: 10px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
        display: flex;
        align-items: center;
        gap: 10px;
    `;
    
    toast.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Add animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// Generate pairing code
async function generatePairingCode() {
    try {
        let phoneNumber = phoneInput.value.replace(/[^0-9]/g, '');
        
        if (!phoneNumber) {
            showToast('Please enter your phone number', 'error');
            return;
        }
        
        if (phoneNumber.length < 9) {
            showToast('Please enter a valid phone number', 'error');
            return;
        }
        
        // Show loading
        generateBtn.disabled = true;
        generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
        
        const response = await fetch('/api/pair/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentSessionId = data.sessionId;
            
            // Display code
            pairingCodeSpan.textContent = data.code;
            
            // Switch to step 2
            step1.classList.remove('active');
            step2.classList.add('active');
            
            // Join socket room
            socket.emit('join-session', data.sessionId);
            
            // Start timer
            startTimer(120);
            
            // Start checking login status
            startLoginCheck(data.sessionId);
            
            showToast('Pairing code generated! Enter it in WhatsApp', 'success');
            
            // Copy to clipboard automatically
            navigator.clipboard.writeText(data.code.replace(/-/g, '')).catch(() => {});
        } else {
            showToast(data.error || 'Failed to generate code', 'error');
            generateBtn.disabled = false;
            generateBtn.innerHTML = '<i class="fas fa-magic"></i> Generate Pairing Code';
        }
        
    } catch (error) {
        console.error('Error:', error);
        showToast('Network error. Please try again.', 'error');
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<i class="fas fa-magic"></i> Generate Pairing Code';
    }
}

// Start timer
function startTimer(seconds) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    let remaining = seconds;
    updateTimer(remaining);
    
    countdownInterval = setInterval(() => {
        remaining--;
        updateTimer(remaining);
        
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            handleCodeExpiry();
        }
    }, 1000);
}

function updateTimer(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    timerSpan.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    
    if (seconds < 30) {
        timerSpan.style.color = '#ff4444';
    } else {
        timerSpan.style.color = '';
    }
}

function handleCodeExpiry() {
    showToast('Code expired. Please generate a new one.', 'warning');
    resetToStep1();
}

// Check login status
function startLoginCheck(sessionId) {
    if (loginCheckInterval) clearInterval(loginCheckInterval);
    
    loginCheckInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/session/status/${sessionId}`);
            const data = await response.json();
            
            if (data.success && data.loggedIn) {
                clearInterval(loginCheckInterval);
                clearInterval(countdownInterval);
                
                // Switch to success screen
                step2.classList.remove('active');
                step3.classList.add('active');
                
                // Display session ID
                sessionIdSpan.textContent = data.sessionId;
                
                showToast('Login successful! Session saved to Mega.nz', 'success');
            } else if (data.error) {
                console.log('Status check:', data.status);
            }
        } catch (error) {
            console.error('Login check error:', error);
        }
    }, 2000);
}

// Reset to step 1
function resetToStep1() {
    step2.classList.remove('active');
    step3.classList.remove('active');
    step1.classList.add('active');
    
    generateBtn.disabled = false;
    generateBtn.innerHTML = '<i class="fas fa-magic"></i> Generate Pairing Code';
    
    if (countdownInterval) clearInterval(countdownInterval);
    if (loginCheckInterval) clearInterval(loginCheckInterval);
    
    currentSessionId = null;
}

// Cancel button
cancelBtn.addEventListener('click', resetToStep1);

// Generate button
generateBtn.addEventListener('click', generatePairingCode);

// Enter key
phoneInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        generatePairingCode();
    }
});

// Socket events
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ Pairing page loaded');
    
    // Check server health
    fetch('/api/health')
        .then(res => res.json())
        .then(data => {
            console.log('Server status:', data.status);
            if (data.footer) {
                const footer = document.querySelector('.footer p');
                if (footer) {
                    footer.innerHTML = data.footer;
                }
            }
        })
        .catch(err => console.error('Health check failed:', err));
});
