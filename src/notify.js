/**
 * Habitica integration — creates a todo in Habitica when something needs attention.
 * 
 * Required env vars:
 *   HABITICA_USER_ID  — Your Habitica User ID  (Settings > API)
 *   HABITICA_API_TOKEN — Your Habitica API Token (Settings > API)
 */

const HABITICA_API = 'https://habitica.com/api/v3';
const ALIAS_PREFIX = 'calendar-sync-';

async function habiticaRequest(method, path, body) {
  const userId = process.env.HABITICA_USER_ID;
  const apiToken = process.env.HABITICA_API_TOKEN;

  if (!userId || !apiToken) {
    return null;
  }

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-user': userId,
      'x-api-key': apiToken,
      'x-client': `${userId}-calendar-sync`,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${HABITICA_API}${path}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Habitica API ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Create or update a Habitica todo for a specific issue.
 * Uses alias-based dedup so the same problem doesn't pile up todos.
 */
async function upsertTodo(alias, text, notes) {
  const fullAlias = `${ALIAS_PREFIX}${alias}`;

  // Try to update existing task by alias
  try {
    await habiticaRequest('PUT', `/tasks/${fullAlias}`, {
      text,
      notes,
    });
    console.log(`[Habitica] Updated existing todo: ${alias}`);
    return;
  } catch {
    // Task doesn't exist — create it
  }

  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    await habiticaRequest('POST', '/tasks/user', {
      type: 'todo',
      alias: fullAlias,
      text,
      notes,
      priority: 1, // Easy
      date: tomorrow.toISOString(),
    });
    console.log(`[Habitica] Created todo: ${alias}`);
  } catch (err) {
    console.error(`[Habitica] Failed to create todo:`, err.message);
  }
}

/**
 * Delete a Habitica todo when the issue is resolved.
 */
async function resolveTodo(alias) {
  const fullAlias = `${ALIAS_PREFIX}${alias}`;
  try {
    await habiticaRequest('POST', `/tasks/${fullAlias}/score/up`);
    console.log(`[Habitica] Completed todo: ${alias}`);
  } catch {
    // Task may not exist, that's fine
  }
}

// --- Public notification helpers ---

export async function notifySyncFailure(errorMessage) {
  await upsertTodo(
    'sync-failure',
    '🔄 Calendar Sync is failing',
    `The calendar sync encountered an error:\n\n${errorMessage}\n\nCheck: ${process.env.BASE_URL || 'https://calendar-sync-ljbw-w.fly.dev'}/`
  );
}

export async function notifySyncRecovered() {
  await resolveTodo('sync-failure');
}

export async function notifyAccountDisconnected(accountNum, detail) {
  await upsertTodo(
    `account-${accountNum}-disconnected`,
    `⚠️ Calendar Sync: Account ${accountNum} disconnected`,
    `Account ${accountNum} lost its connection:\n\n${detail || 'Tokens may be expired or revoked.'}\n\nReconnect at: ${process.env.BASE_URL || 'https://calendar-sync-ljbw-w.fly.dev'}/`
  );
}

export async function notifyAccountReconnected(accountNum) {
  await resolveTodo(`account-${accountNum}-disconnected`);
}

export function isConfigured() {
  return !!(process.env.HABITICA_USER_ID && process.env.HABITICA_API_TOKEN);
}
