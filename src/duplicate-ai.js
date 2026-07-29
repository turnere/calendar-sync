import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

function summarizeEvent(event) {
  return {
    id: event.id,
    title: event.summary || '(no title)',
    start: event.start?.dateTime || event.start?.date,
    location: event.location || undefined
  };
}

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    is_duplicate: { type: 'boolean' },
    matched_event_id: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    reason: { type: 'string' }
  },
  required: ['is_duplicate', 'matched_event_id', 'confidence', 'reason'],
  additionalProperties: false
};

// Ask Claude whether `newEvent` is the same real-world event as one of `sameDayEvents`.
// Returns null if AI isn't configured, on error, or no confident match was found.
export async function findAiDuplicateMatch(newEvent, sameDayEvents) {
  const anthropic = getClient();
  if (!anthropic || sameDayEvents.length === 0) return null;

  const prompt = `A calendar sync tool is about to create this new event:
${JSON.stringify(summarizeEvent(newEvent))}

Here are existing events already on the same day in the target calendar:
${JSON.stringify(sameDayEvents.map(summarizeEvent))}

Does the new event represent the same real-world appointment/meeting as any one of the existing events, even if the wording, capitalization, or exact time differs slightly (e.g. "Dr. Smith" vs "Doctor appointment", "Team sync" vs "Weekly team meeting")? Only flag a match if you are reasonably confident they refer to the same real-world event, not just a similar category of event. If matched, set matched_event_id to that event's id exactly as given.`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      output_config: { format: { type: 'json_schema', schema: MATCH_SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) return null;

    const result = JSON.parse(textBlock.text);
    if (!result.is_duplicate || !result.matched_event_id) return null;
    return result;
  } catch (error) {
    console.error('AI duplicate check failed:', error.message);
    return null;
  }
}
