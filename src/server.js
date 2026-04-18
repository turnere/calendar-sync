import express from 'express';
import session from 'express-session';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { authRouter, getAuthClient } from './auth.js';
import { calendarRouter } from './calendar.js';
import { syncRouter, startSyncScheduler } from './sync.js';
import { initDatabase, getAccountInfo, getTokens, getSyncConfig } from './database.js';
import { isConfigured as isHabiticaConfigured } from './notify.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Session-based auth middleware (if BASIC_AUTH_PASSWORD is set)
const requireLogin = (req, res, next) => {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password) return next(); // Skip if no password configured
  
  // Allow health checks and login page without auth
  if (req.path === '/health' || req.path === '/login') return next();
  
  if (req.session.authenticated) {
    return next();
  }
  
  // For API requests, return 401
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  // For page requests, redirect to login
  return res.redirect('/login');
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requireLogin);

// Trust proxy for secure cookies behind Render's load balancer
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'calendar-sync-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 
  } // 24 hours
}));

// Serve static files
app.use(express.static(join(__dirname, '../public')));

// Login page
app.get('/login', (req, res) => {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password || req.session.authenticated) {
    return res.redirect('/');
  }
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Calendar Sync</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #f5f7fa; color: #333; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-card { background: white; border-radius: 12px; box-shadow: 0 2px 20px rgba(0,0,0,0.1); padding: 40px; width: 100%; max-width: 400px; text-align: center; }
    .login-card h1 { font-size: 1.8rem; margin-bottom: 8px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .login-card p { color: #999; margin-bottom: 30px; }
    .form-group { margin-bottom: 20px; text-align: left; }
    .form-group label { display: block; margin-bottom: 6px; font-weight: 500; color: #555; font-size: 0.9rem; }
    .form-group input { width: 100%; padding: 12px 14px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 1rem; transition: border-color 0.3s; }
    .form-group input:focus { outline: none; border-color: #667eea; }
    .btn-login { width: 100%; padding: 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: opacity 0.3s; }
    .btn-login:hover { opacity: 0.9; }
    .error { background: #ffebee; color: #c62828; padding: 10px; border-radius: 6px; margin-bottom: 20px; font-size: 0.9rem; display: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>Calendar Sync</h1>
    <p>Sign in to manage your sync</p>
    <div id="error" class="error"></div>
    <form action="/login" method="POST" id="login-form">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" value="admin" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      </div>
      <button type="submit" class="btn-login">Sign In</button>
    </form>
  </div>
  <script>
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === '1') {
      const el = document.getElementById('error');
      el.textContent = 'Invalid password. Please try again.';
      el.style.display = 'block';
    }
  </script>
</body>
</html>`);
});

// Login POST handler
app.post('/login', (req, res) => {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (req.body.password === password) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

// Logout handler
app.post('/logout', (req, res) => {
  req.session.authenticated = false;
  res.redirect('/login');
});

// Health check endpoint for Fly.io
app.get('/health', (req, res) => {
  const tokens1 = getTokens(1);
  const tokens2 = getTokens(2);
  const config = getSyncConfig();
  const status = {
    healthy: true,
    account1: !!tokens1,
    account2: !!tokens2,
    syncEnabled: !!config?.enabled,
    lastSync: config?.last_sync || null,
    habitica: isHabiticaConfigured(),
  };
  status.healthy = status.account1 && status.account2 && status.syncEnabled;
  res.status(status.healthy ? 200 : 200).json(status);
});

// Routes
app.use('/auth', authRouter);
app.use('/api/calendars', calendarRouter);
app.use('/api/sync', syncRouter);

// Status endpoint
app.get('/api/status', (req, res) => {
  // Check stored accounts in database (not just session)
  const account1 = getAccountInfo(1);
  const account2 = getAccountInfo(2);
  
  res.json({
    account1Connected: !!account1,
    account2Connected: !!account2,
    account1Email: account1?.email || req.session.email1 || null,
    account2Email: account2?.email || req.session.email2 || null,
    syncConfig: req.session.syncConfig || null
  });
});

// Initialize database and start server
initDatabase();

app.listen(PORT, () => {
  console.log(`Calendar Sync server running at http://localhost:${PORT}`);
  console.log('Open this URL in your browser to configure sync');
  
  // Start sync scheduler
  startSyncScheduler();
});
