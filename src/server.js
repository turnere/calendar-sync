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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'calendar-sync-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static files
app.use(express.static(join(__dirname, '../public')));

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
