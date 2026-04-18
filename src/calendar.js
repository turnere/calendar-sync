import express from 'express';
import { google } from 'googleapis';
import { getAuthClient, getStoredAuthClient } from './auth.js';

export const calendarRouter = express.Router();

// List all calendars for an account
calendarRouter.get('/list/:accountNum', async (req, res) => {
  const accountNum = parseInt(req.params.accountNum);
  
  // Try session tokens first, fall back to stored tokens
  let auth = getAuthClient(accountNum, req.session);
  console.log(`Calendar list for account ${accountNum}: session has token: ${!!auth.credentials?.access_token}`);
  
  if (!auth.credentials || !auth.credentials.access_token) {
    auth = getStoredAuthClient(accountNum);
    console.log(`Using stored auth for account ${accountNum}: ${!!auth?.credentials?.access_token}`);
  }
  
  if (!auth || !auth.credentials || !auth.credentials.access_token) {
    console.log(`Account ${accountNum} not connected - no tokens found`);
    return res.status(401).json({ error: 'Account not connected' });
  }
  
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.calendarList.list();
    
    const calendars = response.data.items.map(cal => ({
      id: cal.id,
      summary: cal.summary,
      description: cal.description,
      primary: cal.primary || false,
      accessRole: cal.accessRole
    }));
    
    res.json(calendars);
  } catch (error) {
    console.error('Error fetching calendars for account', accountNum, ':', error.message);
    if (error.response) {
      console.error('API response:', error.response.data);
    }
    res.status(500).json({ error: 'Failed to fetch calendars', details: error.message });
  }
});

// Get events from a calendar
calendarRouter.get('/events/:accountNum/:calendarId', async (req, res) => {
  const accountNum = parseInt(req.params.accountNum);
  const calendarId = decodeURIComponent(req.params.calendarId);
  const auth = getAuthClient(accountNum, req.session);
  
  if (!auth.credentials || !auth.credentials.access_token) {
    return res.status(401).json({ error: 'Account not connected' });
  }
  
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    
    // Get events from the past month and next 3 months
    const timeMin = new Date();
    timeMin.setMonth(timeMin.getMonth() - 1);
    
    const timeMax = new Date();
    timeMax.setFullYear(timeMax.getFullYear() + 2);
    
    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250
    });
    
    res.json(response.data.items || []);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Helper function to get calendar service
export function getCalendarService(auth) {
  return google.calendar({ version: 'v3', auth });
}

// Get events for sync (used by sync module)
export async function getEventsForSync(auth, calendarId, syncToken = null) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  const params = {
    calendarId,
    singleEvents: true,
    maxResults: 250
  };
  
  if (syncToken) {
    params.syncToken = syncToken;
  } else {
    // Initial sync - get events from past week and future 12 months
    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 7);
    
    const timeMax = new Date();
    timeMax.setFullYear(timeMax.getFullYear() + 2);
    
    params.timeMin = timeMin.toISOString();
    params.timeMax = timeMax.toISOString();
    params.orderBy = 'startTime';
  }
  
  const response = await calendar.events.list(params);
  return {
    events: response.data.items || [],
    nextSyncToken: response.data.nextSyncToken
  };
}

// Create event in target calendar
export async function createEvent(auth, calendarId, event) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  const response = await calendar.events.insert({
    calendarId,
    resource: event
  });
  
  return response.data;
}

// Update event in target calendar
export async function updateEvent(auth, calendarId, eventId, event) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  const response = await calendar.events.update({
    calendarId,
    eventId,
    resource: event
  });
  
  return response.data;
}

// Delete event from target calendar
export async function deleteEvent(auth, calendarId, eventId) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  await calendar.events.delete({
    calendarId,
    eventId
  });
}

// Get single event
export async function getEvent(auth, calendarId, eventId) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  try {
    const response = await calendar.events.get({
      calendarId,
      eventId
    });
    return response.data;
  } catch (error) {
    if (error.code === 404) {
      return null;
    }
    throw error;
  }
}
