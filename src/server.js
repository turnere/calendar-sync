import express from 'express';
import session from 'express-session';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { authRouter, getAuthClient } from './auth.js';
import { calendarRouter } from './calendar.js';
import { syncRouter, startSyncScheduler } from './sync.js';
import { initDatabase, getAccountInfo } from './database.js';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Basic Auth middleware (if BASIC_AUTH_PASSWORD is set)
const basicAuth = (req, res, next) => {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password) return next(); // Skip if no password configured
  
  // Allow health checks without auth
  if (req.path === '/health') return next();
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Calendar Sync"');
    return res.status(401).send('Authentication required');
  }
  
  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [user, pass] = credentials.split(':');
  
  if (pass === password) {
    return next();
  }
  
  res.setHeader('WWW-Authenticate', 'Basic realm="Calendar Sync"');
  return res.status(401).send('Invalid credentials');
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(basicAuth);

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

// Health check endpoint for Fly.io
app.get('/health', (req, res) => {
  res.status(200).send('OK');
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
