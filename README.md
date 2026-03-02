# Calendar Sync

Two-way Google Calendar sync between accounts with duplicate detection. Perfect for syncing events between a business Google account and a personal free account.

## Features

- **Two-way sync**: Events sync both directions between calendars
- **Source identification**: Events are prefixed with their source calendar (e.g., `[Business] Meeting`)
- **Duplicate detection**: Automatically skips events that look like duplicates (same title and time)
- **Automatic sync**: Runs every 5 minutes (configurable)
- **Sync logging**: Track all sync activity and see what was synced
- **Manual sync**: Trigger sync anytime with one click
- **Handles updates**: If an event changes, the synced copy updates too
- **Handles deletions**: If an event is deleted, the synced copy is removed

## Prerequisites

- Node.js 18+ 
- A Google Cloud project with Calendar API enabled
- OAuth 2.0 credentials for your Google Cloud project

## Setup

### 1. Create Google Cloud Project & OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Calendar API**:
   - Go to "APIs & Services" → "Enable APIs and Services"
   - Search for "Google Calendar API" and enable it
4. Configure OAuth consent screen:
   - Go to "APIs & Services" → "OAuth consent screen"
   - Choose "External" user type
   - Fill in app name, user support email, developer contact email
   - Add scopes: `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/userinfo.email`
   - Add your email addresses as test users (required while app is in testing)
5. Create OAuth credentials:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: "Web application"
   - Name: "Calendar Sync"
   - Authorized redirect URIs:
     - `http://localhost:3000/auth/callback/1`
     - `http://localhost:3000/auth/callback/2`
   - Click "Create" and save the Client ID and Client Secret

### 2. Configure the App

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your credentials:
   ```env
   GOOGLE_CLIENT_ID_1=your_client_id
   GOOGLE_CLIENT_SECRET_1=your_client_secret
   
   # You can use the same credentials for both accounts
   GOOGLE_CLIENT_ID_2=your_client_id
   GOOGLE_CLIENT_SECRET_2=your_client_secret
   
   SESSION_SECRET=generate_a_random_string_here
   PORT=3000
   BASE_URL=http://localhost:3000
   SYNC_INTERVAL_MINUTES=5
   ```

### 3. Install & Run

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or for development with auto-reload
npm run dev
```

### 4. Configure Sync

1. Open http://localhost:3000 in your browser
2. Connect both Google accounts (click "Connect Account" for each)
3. Select which calendar to sync from each account
4. Set prefixes for identifying event sources
5. Save configuration and enable sync

## How It Works

### Sync Process

1. Fetches events from both calendars (past week to 6 months ahead)
2. For each event in Calendar 1:
   - Checks if it was originally synced FROM Calendar 2 (skips to avoid ping-pong)
   - Checks if already synced (updates if changed)
   - Checks for duplicates in Calendar 2 (skips if found)
   - Creates synced copy in Calendar 2 with source prefix
3. Repeats process for Calendar 2 → Calendar 1
4. Logs all activity

### Duplicate Detection

Events are considered duplicates if they:
- Start at the same time
- Have the same or similar title (case-insensitive, ignoring prefixes)

### Event Identification

- Synced events get a prefix in the title (e.g., `[Business] Team Meeting`)
- A hidden marker is added to the description to track sync relationships
- This prevents infinite sync loops between calendars

## Troubleshooting

### "Account not connected" error

Make sure:
- Your Google Cloud project has the Calendar API enabled
- Your email is added as a test user in the OAuth consent screen
- The redirect URIs in Google Cloud match exactly

### Duplicate events keep appearing

- Try clicking "Sync Now" manually first
- Check the sync logs to see what's happening
- Events with different times but same title won't be detected as duplicates

### Token expired errors

- Disconnect and reconnect the affected account
- The app requests offline access, so refresh tokens should work automatically

## Running in Production

For production use:

1. Set `BASE_URL` to your production URL
2. Add production redirect URIs to Google Cloud
3. Use a process manager like PM2
4. Consider using HTTPS with a reverse proxy

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start src/server.js --name calendar-sync
```

## Data Storage

- Tokens and sync data are stored in `data/calendar-sync.db` (SQLite)
- You can delete this file to reset all configuration

## API Endpoints

- `GET /api/status` - Get connection status
- `GET /api/calendars/list/:accountNum` - List calendars for account
- `GET /api/sync/config` - Get sync configuration
- `POST /api/sync/config` - Save sync configuration
- `POST /api/sync/now` - Trigger manual sync
- `POST /api/sync/toggle` - Enable/disable automatic sync
- `GET /api/sync/logs` - Get sync activity logs

## License

MIT
