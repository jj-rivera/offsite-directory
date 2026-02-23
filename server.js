require('dotenv').config();
const express = require('express');
const { WebClient } = require('@slack/web-api');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const CHANNEL_NAME = 'temp-horizon3-alignment-dqs-appsframework-meetup-ncr26';
const CHANNEL_ID_OVERRIDE = process.env.SLACK_CHANNEL_ID || null;
const TEAM_ID = process.env.SLACK_TEAM_ID || '';

// In-memory cache
let cachedMembers = null;
let cacheTimestamp = null;
const CACHE_TTL = 10 * 60 * 1000;

// Leaderboard (in-memory)
let leaderboard = [];

app.use(express.static(path.join(__dirname, 'public')));

async function findChannelId() {
  const channelTypes = ['public_channel', 'private_channel'];
  for (const type of channelTypes) {
    try {
      let cursor;
      do {
        const result = await slack.conversations.list({
          types: type,
          limit: 200,
          cursor,
        });
        const channel = result.channels.find(c => c.name === CHANNEL_NAME);
        if (channel) return channel.id;
        cursor = result.response_metadata?.next_cursor;
      } while (cursor);
    } catch (err) {
      console.warn(`Could not list ${type}: ${err.message}`);
    }
  }
  throw new Error(
    `Channel #${CHANNEL_NAME} not found. Your token may need additional scopes: channels:read, groups:read, users:read`
  );
}

async function getChannelMembers(channelId) {
  const memberIds = [];
  let cursor;
  do {
    const result = await slack.conversations.members({
      channel: channelId,
      limit: 200,
      cursor,
    });
    memberIds.push(...result.members);
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
  return memberIds;
}

async function getUserProfiles(memberIds) {
  const profiles = [];
  const batchSize = 20;
  for (let i = 0; i < memberIds.length; i += batchSize) {
    const batch = memberIds.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (userId) => {
        try {
          const result = await slack.users.info({ user: userId });
          const user = result.user;
          if (user.is_bot || user.deleted) return null;

          const profile = user.profile;
          let pronunciation = null;
          const displayName = profile.display_name || '';
          const pronMatch = displayName.match(/[\(\[](.*?)[\)\]]/);
          if (pronMatch) {
            pronunciation = pronMatch[1].trim();
          }
          if (profile.pronunciation && profile.pronunciation.trim()) {
            pronunciation = profile.pronunciation.trim();
          }

          return {
            id: userId,
            name: profile.real_name || profile.display_name || user.name || 'Unknown',
            title: profile.title || '',
            photo: profile.image_512 || profile.image_192 || profile.image_72 || null,
            pronunciation,
            startDate: profile.start_date || null,
          };
        } catch (err) {
          console.error(`Failed to fetch user ${userId}:`, err.message);
          return null;
        }
      })
    );
    profiles.push(...results.filter(Boolean));
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

app.get('/api/members', async (req, res) => {
  try {
    if (cachedMembers && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_TTL) {
      return res.json({ members: cachedMembers, teamId: TEAM_ID, cached: true });
    }

    console.log('Fetching fresh data from Slack...');
    const channelId = CHANNEL_ID_OVERRIDE || await findChannelId();
    console.log(`Using channel: ${channelId}`);

    const memberIds = await getChannelMembers(channelId);
    console.log(`Found ${memberIds.length} members`);

    const members = await getUserProfiles(memberIds);
    console.log(`Fetched ${members.length} profiles`);

    cachedMembers = members;
    cacheTimestamp = Date.now();

    res.json({ members, teamId: TEAM_ID, cached: false });
  } catch (err) {
    console.error('Error fetching members:', err);
    if (cachedMembers) {
      return res.json({ members: cachedMembers, teamId: TEAM_ID, cached: true, stale: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — remove after deploy is working
app.get('/api/debug', (req, res) => {
  res.json({
    hasToken: !!process.env.SLACK_BOT_TOKEN,
    tokenPrefix: (process.env.SLACK_BOT_TOKEN || '').substring(0, 10),
    channelId: process.env.SLACK_CHANNEL_ID || 'NOT SET',
    teamId: process.env.SLACK_TEAM_ID || 'NOT SET',
    channelIdOverride: CHANNEL_ID_OVERRIDE,
  });
});

app.post('/api/refresh', async (req, res) => {
  cachedMembers = null;
  cacheTimestamp = null;
  res.json({ ok: true });
});

// Leaderboard endpoints
app.get('/api/leaderboard', (req, res) => {
  const sorted = [...leaderboard].sort((a, b) => b.score - a.score).slice(0, 50);
  res.json({ leaderboard: sorted });
});

app.post('/api/leaderboard', (req, res) => {
  const { nickname, score, correct, total } = req.body;
  if (!nickname || typeof score !== 'number') {
    return res.status(400).json({ error: 'nickname and score required' });
  }
  const entry = {
    nickname: String(nickname).slice(0, 20),
    score,
    correct: correct || 0,
    total: total || 10,
    timestamp: Date.now(),
  };
  leaderboard.push(entry);
  // Keep only top 200
  if (leaderboard.length > 200) {
    leaderboard.sort((a, b) => b.score - a.score);
    leaderboard = leaderboard.slice(0, 200);
  }
  const sorted = [...leaderboard].sort((a, b) => b.score - a.score).slice(0, 50);
  res.json({ leaderboard: sorted });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Offsite directory running at http://localhost:${PORT}`);
  console.log(`Share your local IP on the same WiFi for others to access`);
});
