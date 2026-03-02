import express from 'express';
import { google } from 'googleapis';
import { saveTokens, getTokens } from './database.js';

export const authRouter = express.Router();

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Create OAuth2 client for account 1
function getOAuth2Client1() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID_1,
    process.env.GOOGLE_CLIENT_SECRET_1,
    `${process.env.BASE_URL || 'http://localhost:3000'}/auth/callback/1`
  );
}

// Create OAuth2 client for account 2
function getOAuth2Client2() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID_2 || process.env.GOOGLE_CLIENT_ID_1,
    process.env.GOOGLE_CLIENT_SECRET_2 || process.env.GOOGLE_CLIENT_SECRET_1,
    `${process.env.BASE_URL || 'http://localhost:3000'}/auth/callback/2`
  );
}

// Get authenticated client for an account
export function getAuthClient(accountNum, session) {
  const oauth2Client = accountNum === 1 ? getOAuth2Client1() : getOAuth2Client2();
  const tokens = accountNum === 1 ? session.tokens1 : session.tokens2;
  
  if (tokens) {
    oauth2Client.setCredentials(tokens);
  }
  
  return oauth2Client;
}

// Get stored tokens and create client
export function getStoredAuthClient(accountNum) {
  const oauth2Client = accountNum === 1 ? getOAuth2Client1() : getOAuth2Client2();
  const tokens = getTokens(accountNum);
  
  if (tokens) {
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
  }
  
  return null;
}

// Start OAuth flow for account 1
authRouter.get('/login/1', (req, res) => {
  const oauth2Client = getOAuth2Client1();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Force consent to get refresh token
  });
  res.redirect(authUrl);
});

// Start OAuth flow for account 2
authRouter.get('/login/2', (req, res) => {
  const oauth2Client = getOAuth2Client2();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// OAuth callback for account 1
authRouter.get('/callback/1', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  
  try {
    const oauth2Client = getOAuth2Client1();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    req.session.tokens1 = tokens;
    req.session.email1 = userInfo.data.email;
    
    // Save tokens to database for background sync
    saveTokens(1, tokens, userInfo.data.email);
    
    res.redirect('/?account1=connected');
  } catch (error) {
    console.error('Error getting tokens for account 1:', error);
    res.redirect('/?error=auth_failed');
  }
});

// OAuth callback for account 2
authRouter.get('/callback/2', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  
  try {
    const oauth2Client = getOAuth2Client2();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    req.session.tokens2 = tokens;
    req.session.email2 = userInfo.data.email;
    
    // Save tokens to database for background sync
    saveTokens(2, tokens, userInfo.data.email);
    
    res.redirect('/?account2=connected');
  } catch (error) {
    console.error('Error getting tokens for account 2:', error);
    res.redirect('/?error=auth_failed');
  }
});

// Disconnect account
authRouter.post('/disconnect/:accountNum', (req, res) => {
  const accountNum = parseInt(req.params.accountNum);
  
  if (accountNum === 1) {
    req.session.tokens1 = null;
    req.session.email1 = null;
  } else {
    req.session.tokens2 = null;
    req.session.email2 = null;
  }
  
  res.json({ success: true });
});
